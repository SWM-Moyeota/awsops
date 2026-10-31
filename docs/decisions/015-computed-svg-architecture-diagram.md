# ADR-015: Computed-Layout SVG for the Architecture Diagram / 아키텍처 다이어그램을 계산된 배치의 SVG로

## Status: Accepted / 상태: 승인됨 (2026-10-31)

## Context / 컨텍스트

`/diagram` ran a Python script (mingrammer `diagrams` + Graphviz) that produced a PNG. Graphviz decides positions itself, so the picture could not hold the shape people expect from an AWS architecture diagram: AZs side by side, tiers on one line, Internet at the top. Arrows cut through subnets, icons were oversized, and only EC2, ALB and NAT were drawn. It also needed a Python package and a system binary on the server.

`/diagram`은 Python 스크립트(mingrammer `diagrams` + Graphviz)로 PNG를 만들었다. Graphviz가 위치를 직접 정하므로 AWS 아키텍처 그림에 기대하는 모양(AZ 나란히, 티어 한 줄, 인터넷은 위쪽)을 유지할 수 없었다. 화살표가 서브넷을 가로지르고 아이콘이 너무 컸으며 EC2·ALB·NAT만 그렸다. 서버에 Python 패키지와 시스템 바이너리도 필요했다.

## Decision / 결정

Replace it with pure TypeScript in `src/lib/arch-diagram/`: rows to a VPC > AZ > subnet model, a deterministic grid layout, an orthogonal A* edge router that avoids icons and titles, and a standalone SVG with official AWS icons, numbered badges and a legend. `/api/diagram` returns `image/svg+xml`; the page shows it through `<img>` and exports PNG in the browser. Only relations the data proves are drawn.

`src/lib/arch-diagram/`의 순수 TypeScript로 바꾼다. 행을 VPC > AZ > 서브넷 모델로 바꾸고, 결정적 격자로 배치하고, 아이콘과 제목을 피하는 직각 A* 경로를 찾아, 공식 AWS 아이콘·번호 뱃지·범례가 있는 독립 SVG를 만든다. `/api/diagram`은 `image/svg+xml`을 돌려주고, 화면은 `<img>`로 보여 주며 PNG는 브라우저에서 만든다. 데이터로 확인되는 관계만 그린다.

## Alternatives / 대안 비교

| | Computed SVG (chosen) | Tune Graphviz | ELK.js | React Flow |
|---|---|---|---|---|
| Fixed AWS shape / 정해진 AWS 모양 | Exact | Fights the engine | Close, needs tuning | Manual |
| Server deps / 서버 의존성 | None | Python + binary | New npm package | None |
| Unit-testable geometry / 배치 시험 | Yes | No | Partly | No |
| Export / 내보내기 | SVG + PNG | PNG | SVG | Screenshot |
| Cost / 비용 | Own router and layout code | Little code | Little code, less control | Already free-form in `/topology-view` |

## Evaluation / 평가

Rendered from real sandbox rows for four VPCs and from a synthetic 2-AZ fixture in both directions, checked by eye in headless Chrome. Tests pin determinism, frame nesting, no overlap between icons and labels, and that edges avoid icons and titles.

실제 샌드박스 VPC 4개의 행과 합성 2-AZ 픽스처를 두 방향으로 그려 헤드리스 Chrome에서 눈으로 확인했다. 시험은 결정성, 틀의 포함 관계, 아이콘·글자 겹침 없음, 선이 아이콘과 제목을 피함을 고정한다.

## Consequences / 결과

- `tools/diagram/` and the Step 2 `graphviz` + `diagrams` install are gone. Servers that already have them are unaffected.
- Links between EC2 and databases or caches are not drawn, because the rows do not prove them. Security-group analysis could add them later.
- ElastiCache is placed by AZ only.
- The router has a 3-second budget per diagram; past it, the remaining edges are left out and the legend says how many.
- Icons are a 2021 release, copied in as data rather than added as a dependency.

- `tools/diagram/`과 Step 2의 `graphviz`·`diagrams` 설치를 없앴다. 이미 깔린 서버는 영향 없다.
- EC2와 DB·캐시 사이의 선은 행으로 확인할 수 없어 그리지 않는다. 나중에 보안그룹 분석으로 더할 수 있다.
- ElastiCache는 AZ 단위로만 놓인다.
- 경로 탐색은 그림당 3초 예산이고, 넘으면 남은 선은 그리지 않고 범례에 개수를 적는다.
- 아이콘은 2021년 릴리스이며 의존성이 아니라 데이터로 복사해 넣었다.
