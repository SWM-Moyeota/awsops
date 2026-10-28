// Root-cause page — server wrapper that loads the page-only Pretendard font; Suspense for ?id= (useSearchParams).
// 장애 원인 분석 페이지 — 이 페이지에서만 쓰는 Pretendard 글꼴을 주입하는 서버 래퍼, ?id= 읽기용 Suspense.
import { Suspense } from 'react';
import localFont from 'next/font/local';
import RootCauseView from '@/components/root-cause/RootCauseView';

const pretendard = localFont({
  src: '../changes/fonts/PretendardVariable.woff2',
  weight: '45 920',
  display: 'swap',
  variable: '--font-pretendard',
});

export default function RootCausePage() {
  return (
    <div className={`${pretendard.variable} p-4 md:p-6`}>
      <Suspense>
        <RootCauseView />
      </Suspense>
    </div>
  );
}
