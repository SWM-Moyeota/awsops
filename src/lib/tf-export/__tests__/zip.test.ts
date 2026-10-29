// Stored zip writer / 저장 방식 zip 작성기
import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { crc32, makeZip } from '../zip';

// Parse local file headers back out of a zip / zip에서 로컬 파일 헤더를 다시 읽기
function parse(buf: Buffer): Array<{ name: string; data: Buffer; crc: number; flags: number; method: number }> {
  const out = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const flags = buf.readUInt16LE(p + 6);
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
    const data = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + size);
    out.push({ name, data, crc, flags, method });
    p += 30 + nlen + xlen + size;
  }
  return out;
}

describe('crc32', () => {
  it('matches the known vector and zlib', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const z = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
    const sample = Buffer.from('resource "aws_vpc" "main" {}\n한국어 ✓');
    if (z) expect(crc32(sample)).toBe(z(sample));
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('makeZip', () => {
  it('round-trips names and contents with matching CRCs', () => {
    const files = [
      { name: 'providers.tf', data: 'terraform {}\n' },
      { name: 'README.md', data: '# 한국어 안내\n' },
      { name: 'lambda-placeholder.zip', data: makeZip([]) },
    ];
    const zip = makeZip(files);
    const back = parse(zip);
    expect(back.map(f => f.name)).toEqual(files.map(f => f.name));
    back.forEach((f, i) => {
      const want = typeof files[i].data === 'string' ? Buffer.from(files[i].data as string) : files[i].data as Buffer;
      expect(f.data.equals(want)).toBe(true);
      expect(f.crc).toBe(crc32(want));
      expect(f.method).toBe(0);
      expect(f.flags & 0x0800).toBe(0x0800);
    });
    // End of central directory with the file count / 중앙 디렉터리 끝에 파일 수
    const eocd = zip.subarray(zip.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(10)).toBe(3);
  });

  it('is deterministic and an empty zip is 22 bytes', () => {
    const a = makeZip([{ name: 'a.tf', data: 'x' }]);
    expect(makeZip([{ name: 'a.tf', data: 'x' }]).equals(a)).toBe(true);
    expect(makeZip([]).length).toBe(22);
  });

  it('rejects unsafe names', () => {
    expect(() => makeZip([{ name: '../x', data: '' }])).toThrow('BadZipName');
    expect(() => makeZip([{ name: '/etc/x', data: '' }])).toThrow('BadZipName');
  });
});
