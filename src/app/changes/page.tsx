// Change timeline page — server wrapper that loads the page-only Pretendard font as a CSS variable.
// 변경 기록 페이지 — 이 페이지에서만 쓰는 Pretendard 글꼴을 CSS 변수로 주입하는 서버 래퍼.
import localFont from 'next/font/local';
import ChangeTimelineView from '@/components/changes/ChangeTimelineView';

const pretendard = localFont({
  src: './fonts/PretendardVariable.woff2',
  weight: '45 920',
  display: 'swap',
  variable: '--font-pretendard',
});

export default function ChangesPage() {
  return (
    <div className={`${pretendard.variable} p-4 md:p-6`}>
      <ChangeTimelineView />
    </div>
  );
}
