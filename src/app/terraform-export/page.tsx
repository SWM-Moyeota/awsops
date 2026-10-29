// Terraform export page — server wrapper that loads the page-only Pretendard font around the client view.
// Terraform 코드 변환 페이지 — 이 페이지에서만 쓰는 Pretendard 글꼴을 주입하고 클라이언트 본문을 감싸는 서버 래퍼.
import localFont from 'next/font/local';
import TfExportView from '@/components/tf-export/TfExportView';

const pretendard = localFont({
  src: '../changes/fonts/PretendardVariable.woff2',
  weight: '45 920',
  display: 'swap',
  variable: '--font-pretendard',
});

export default function TerraformExportPage() {
  return (
    <div className={`${pretendard.variable} p-4 md:p-6 font-[family-name:var(--font-pretendard)]`}>
      <TfExportView />
    </div>
  );
}
