// i18n status messages / 다국어 상태 메시지 (ko/en/zh)
export function pick(lang: string | undefined, en: string, ko: string, zh: string): string {
  return lang === 'ko' ? ko : lang === 'zh' ? zh : en;
}

export function buildStatus(clientLang?: string) {
  const pick = (en: string, ko: string, zh: string) => clientLang === 'ko' ? ko : clientLang === 'zh' ? zh : en;
  return {
    classifying: pick('🔍 Analyzing question...', '🔍 질문 분석 중...', '🔍 正在分析问题...'),
    multiRoute: (names: string) => pick(`📡 Multi-route: ${names}`, `📡 멀티 라우트: ${names}`, `📡 多路由: ${names}`),
    connecting: (display: string) => pick(`📡 Connecting to ${display}...`, `📡 ${display} 연결 중...`, `📡 正在连接 ${display}...`),
    sqlRetrying: pick('🔄 Retrying with corrected SQL...', '🔄 SQL 수정 후 재시도...', '🔄 修正 SQL 后重试...'),
    analyzing: (count: number) => pick(`📊 Analyzing ${count} rows of data...`, `📊 ${count}건 데이터 분석 중...`, `📊 正在分析 ${count} 行数据...`),
    synthesizing: (count: number) => pick(`📊 Synthesizing ${count} responses...`, `📊 ${count}개 응답 합성 중...`, `📊 正在合成 ${count} 个响应...`),
    gatewayTimeout: pick('🔄 Gateway timeout, switching to Bedrock Direct...', '🔄 Gateway 타임아웃, Bedrock Direct로 전환...', '🔄 Gateway 超时，切换到 Bedrock Direct...'),
    fallback: pick('🔄 Bedrock Direct fallback...', '🔄 Bedrock Direct 폴백...', '🔄 Bedrock Direct 回退...'),
    codeGenerating: pick('💻 Generating code...', '💻 코드 생성 중...', '💻 正在生成代码...'),
    codeExecuting: pick('⚡ Executing code...', '⚡ 코드 실행 중...', '⚡ 正在执行代码...'),
    sqlGenerating: pick('📝 Generating SQL...', '📝 SQL 생성 중...', '📝 正在生成 SQL...'),
    sqlQuerying: (retry: boolean) => pick(`🔎 Running Steampipe query...${retry ? ' (retry)' : ''}`, `🔎 Steampipe 쿼리 실행 중...${retry ? ' (재시도)' : ''}`, `🔎 正在运行 Steampipe 查询...${retry ? '（重试）' : ''}`),
    sqlFallback: pick('⚠️ SQL failed, switching to AgentCore...', '⚠️ SQL 실패, AgentCore로 전환...', '⚠️ SQL 失败，切换到 AgentCore...'),
    multiCall: (count: number) => pick(`🤖 Calling ${count} Gateways in parallel...`, `🤖 ${count}개 Gateway 병렬 호출 중...`, `🤖 正在并行调用 ${count} 个 Gateway...`),
    multiCallProgress: (count: number, sec: number) => pick(`🤖 Running ${count} Gateways... (${sec}s)`, `🤖 ${count}개 Gateway 실행 중... (${sec}s)`, `🤖 ${count} 个 Gateway 运行中... (${sec}s)`),
    agentcoreCall: (display: string) => pick(`🤖 Calling ${display} tools...`, `🤖 ${display} 도구 호출 중...`, `🤖 正在调用 ${display} 工具...`),
    agentcoreProgress: (display: string, sec: number) => pick(`🤖 Running ${display} tools... (${sec}s)`, `🤖 ${display} 도구 실행 중... (${sec}s)`, `🤖 ${display} 工具运行中... (${sec}s)`),
    topologyResolving: pick('🗺️ Resolving target VPC...', '🗺️ 대상 VPC 확인 중...', '🗺️ Resolving target VPC...'),
  };
}
