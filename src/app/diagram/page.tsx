'use client';

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MessageSquare, Send, X, Download } from 'lucide-react';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import Header from '@/components/layout/Header';
import { queries as relQ } from '@/lib/queries/relationships';
import { useAccountContext } from '@/contexts/AccountContext';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface DiagramOptions {
  direction: 'TB' | 'LR';
  includeEmpty: boolean;
  excludeSubnets: string[];
  includeServices: boolean;
}

function DiagramContent() {
  const { t, lang } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const searchParams = useSearchParams();
  const [vpcRows, setVpcRows] = useState<any[]>([]);
  const [vpc, setVpc] = useState<string>(searchParams.get('vpc') || '');
  const [options, setOptions] = useState<DiagramOptions>({
    direction: 'TB',
    includeEmpty: false,
    excludeSubnets: [],
    includeServices: true,
  });
  const [svgText, setSvgText] = useState<string | null>(null);
  const [imgFull, setImgFull] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // VPC/subnet inventory for the selector and chat context
  // VPC/서브넷 목록 (셀렉터 + 채팅 컨텍스트용)
  useEffect(() => {
    setVpcRows([]);
    setOptions((p) => ({ ...p, excludeSubnets: [] }));
    let stale = false;
    (async () => {
      try {
        const res = await fetch('/api/steampipe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: currentAccountId,
            queries: { vpcSubnets: relQ.vpcSubnets },
          }),
        });
        const d = await res.json();
        if (!stale) setVpcRows(d.vpcSubnets?.rows || []);
      } catch {}
    })();
    return () => {
      stale = true;
    };
  }, [currentAccountId]);

  const vpcs = useMemo(() => {
    const seen = new Map<string, { vpcId: string; name: string; cidr: string }>();
    vpcRows.forEach((r) => {
      if (r.vpc_id && !seen.has(r.vpc_id)) {
        seen.set(r.vpc_id, { vpcId: r.vpc_id, name: r.vpc_name || r.vpc_id, cidr: r.vpc_cidr || '' });
      }
    });
    return Array.from(seen.values());
  }, [vpcRows]);

  // A choice from another account is not in this list: fall back to the first VPC / 다른 계정에서 고른 VPC는 목록에 없으니 첫 VPC로
  const activeVpc = vpcs.find((v) => v.vpcId === vpc || v.name === vpc)?.vpcId || vpcs[0]?.vpcId || '';
  const activeVpcName = vpcs.find((v) => v.vpcId === activeVpc)?.name || activeVpc;

  const subnets = useMemo(
    () =>
      vpcRows
        .filter((r) => r.vpc_id === activeVpc && r.subnet_id)
        .map((r) => ({ id: r.subnet_id, name: r.subnet_name || r.subnet_id })),
    [vpcRows, activeVpc]
  );

  // Only the latest request may touch the picture / 가장 최근 요청만 그림을 바꿀 수 있음
  const requestSeq = useRef(0);
  const render = useCallback(async (refresh = false) => {
    const seq = ++requestSeq.current;
    if (!activeVpc) {
      setSvgText(null);
      setRendering(false);
      return;
    }
    setRendering(true);
    setRenderError(null);
    try {
      const res = await fetch('/api/diagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vpc: activeVpc,
          accountId: currentAccountId,
          direction: options.direction,
          includeEmpty: options.includeEmpty,
          excludeSubnets: options.excludeSubnets,
          includeServices: options.includeServices,
          lang,
          refresh,
        }),
      });
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const text = await res.text();
      if (seq === requestSeq.current) setSvgText(text);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setSvgText(null);
      setRenderError(err.message);
    } finally {
      if (seq === requestSeq.current) setRendering(false);
    }
  }, [activeVpc, currentAccountId, options, lang]);

  useEffect(() => {
    render();
  }, [render]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs, chatBusy]);

  // Shown through <img>: scripts in an SVG image never run / <img>로 보여 주므로 SVG 안의 스크립트는 실행되지 않음
  const imgUrl = useMemo(() => (svgText ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}` : null), [svgText]);
  const fileBase = `awsops-${activeVpcName.replace(/[^A-Za-z0-9._-]+/g, '-')}-diagram`;

  const save = (href: string, name: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
  };
  const downloadSvg = () => {
    if (imgUrl) save(imgUrl, `${fileBase}.svg`);
  };
  // PNG at twice the size so it stays sharp in reports / 보고서에서도 선명하도록 2배 크기 PNG
  const downloadPng = () => {
    if (!imgUrl) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      save(canvas.toDataURL('image/png'), `${fileBase}.png`);
    };
    img.src = imgUrl;
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const nextMsgs: ChatMsg[] = [...chatMsgs, { role: 'user', content: text }];
    setChatMsgs(nextMsgs);
    setChatInput('');
    setChatBusy(true);
    try {
      const res = await fetch('/api/diagram-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMsgs,
          context: {
            vpcId: activeVpc,
            vpcName: activeVpcName,
            vpcs,
            subnets,
            options,
          },
          lang,
        }),
      });
      const out = await res.json();
      if (out.action === 'options' && out.options) {
        const o = out.options as Record<string, any>;
        if (o.vpc) setVpc(o.vpc);
        const switchedVpc = !!o.vpc && o.vpc !== activeVpc;
        setOptions((p) => ({
          direction: o.direction === 'LR' || o.direction === 'TB' ? o.direction : p.direction,
          includeEmpty: o.includeEmpty !== undefined ? Boolean(o.includeEmpty) : p.includeEmpty,
          excludeSubnets: Array.isArray(o.excludeSubnets)
            ? o.excludeSubnets.filter((s: any) => typeof s === 'string')
            : switchedVpc
              ? []
              : p.excludeSubnets,
          includeServices: o.includeServices !== undefined ? Boolean(o.includeServices) : p.includeServices,
        }));
        setChatMsgs((m) => [...m, { role: 'assistant', content: out.message || 'OK' }]);
      } else {
        setChatMsgs((m) => [
          ...m,
          { role: 'assistant', content: out.message || out.error || '...' },
        ]);
      }
    } catch (err: any) {
      setChatMsgs((m) => [...m, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <Header title={t('diagram.title')} subtitle={t('diagram.subtitle')} onRefresh={() => render(true)} />

      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={activeVpc}
          onChange={(e) => {
            setVpc(e.target.value);
            setOptions((p) => ({ ...p, excludeSubnets: [] }));
          }}
          className="bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent-cyan"
        >
          {vpcs.length === 0 && <option value="">{t('diagram.selectVpc')}</option>}
          {vpcs.map((v) => (
            <option key={v.vpcId} value={v.vpcId}>
              {v.name} ({v.cidr})
            </option>
          ))}
        </select>
        <div className="flex gap-1 bg-navy-800 rounded-lg border border-navy-600 p-1">
          {(['TB', 'LR'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setOptions((p) => ({ ...p, direction: d }))}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                options.direction === d
                  ? 'bg-accent-cyan/10 text-accent-cyan'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {d === 'TB' ? t('diagram.vertical') : t('diagram.horizontal')}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={options.includeEmpty}
            onChange={(e) => setOptions((p) => ({ ...p, includeEmpty: e.target.checked }))}
            className="accent-cyan-400"
          />
          {t('diagram.emptySubnets')}
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={options.includeServices}
            onChange={(e) => setOptions((p) => ({ ...p, includeServices: e.target.checked }))}
            className="accent-cyan-400"
          />
          {t('diagram.accountServices')}
        </label>
        <button
          onClick={downloadPng}
          disabled={!imgUrl || rendering}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border bg-navy-800 text-gray-300 border-navy-600 hover:text-white disabled:opacity-40"
        >
          <Download size={15} />
          PNG
        </button>
        <button
          onClick={downloadSvg}
          disabled={!imgUrl || rendering}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border bg-navy-800 text-gray-300 border-navy-600 hover:text-white disabled:opacity-40"
        >
          <Download size={15} />
          SVG
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            chatOpen
              ? 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/40'
              : 'bg-navy-800 text-gray-300 border-navy-600 hover:text-white'
          }`}
        >
          <MessageSquare size={15} />
          {t('topologyView.chat')}
        </button>
        {options.excludeSubnets.length > 0 && (
          <span className="text-xs text-amber-400">
            {t('diagram.excluded', { count: options.excludeSubnets.length })}
          </span>
        )}
        {rendering && (
          <span className="text-xs text-accent-cyan animate-pulse">{t('diagram.rendering')}</span>
        )}
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 240px)' }}>
        <div className="flex-1 bg-white rounded-lg border border-navy-600 overflow-auto p-3">
          {renderError ? (
            <div className="text-sm text-red-400 p-6">{renderError}</div>
          ) : imgUrl ? (
            // Click toggles fit-to-width <-> natural size (block layout — flex
            // centering clips oversized images past the scrollable edge)
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgUrl}
              alt="diagram"
              onClick={() => setImgFull((v) => !v)}
              title={imgFull ? t('diagram.fitToWidth') : t('diagram.actualSize')}
              className={`block mx-auto h-auto ${imgFull ? 'max-w-none cursor-zoom-out' : 'max-w-full cursor-zoom-in'}`}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-gray-500">
              {rendering ? t('diagram.rendering') : t('topologyView.empty')}
            </div>
          )}
        </div>

        {chatOpen && (
          <div className="w-96 flex flex-col bg-navy-900 rounded-lg border border-navy-600 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-navy-600">
              <span className="text-sm font-semibold text-white">{t('diagram.chatTitle')}</span>
              <button onClick={() => setChatOpen(false)} className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMsgs.length === 0 && (
                <div className="text-xs text-gray-500 whitespace-pre-line">
                  {t('diagram.chatExamples')}
                </div>
              )}
              {chatMsgs.map((m, i) => (
                <div
                  key={i}
                  className={`text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words ${
                    m.role === 'user'
                      ? 'bg-accent-cyan/10 text-accent-cyan ml-6'
                      : 'bg-navy-800 text-gray-300 mr-6 border border-navy-600'
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {chatBusy && (
                <div className="text-xs text-accent-cyan animate-pulse">
                  {t('topologyView.chatThinking')}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="p-3 border-t border-navy-600 flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendChat();
                }}
                placeholder={t('diagram.chatPlaceholder')}
                disabled={chatBusy}
                className="flex-1 bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent-cyan disabled:opacity-50"
              />
              <button
                onClick={sendChat}
                disabled={chatBusy || !chatInput.trim()}
                className="px-3 py-2 rounded-lg bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/40 disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiagramPage() {
  return (
    <Suspense>
      <DiagramContent />
    </Suspense>
  );
}
