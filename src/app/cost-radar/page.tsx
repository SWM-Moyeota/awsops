// Cost Radar page — server wrapper that loads the page-only fonts (Archivo Black, Caveat) as CSS variables.
// 비용 레이더 페이지 — 이 페이지에서만 쓰는 글꼴(Archivo Black, Caveat)을 CSS 변수로 주입하는 서버 래퍼.
import { Archivo_Black, Caveat } from 'next/font/google';
import CostRadarView from '@/components/cost-radar/CostRadarView';

const display = Archivo_Black({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--font-cr-display' });
const hand = Caveat({ weight: '700', subsets: ['latin'], display: 'swap', variable: '--font-cr-hand' });

export default function CostRadarPage() {
  return (
    <div className={`${display.variable} ${hand.variable} p-4 md:p-6`}>
      <CostRadarView />
    </div>
  );
}
