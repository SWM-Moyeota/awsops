// Dependency graph page — thin server wrapper around the client view.
// 의존성 그래프 페이지 — 클라이언트 본문을 감싸는 얇은 서버 래퍼.
import DepGraphView from '@/components/dep-graph/DepGraphView';

export default function DependencyGraphPage() {
  return (
    <div className="p-4 md:p-6">
      <DepGraphView />
    </div>
  );
}
