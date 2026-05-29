/**
 * 공시한장 (Gongsi Hanjang) — 백엔드 서버 v3.0
 *
 * 실행:
 *   export DART_API_KEY=키값
 *   export GEMINI_API_KEY=키값
 *   node server.js  →  http://localhost:3000
 */

const express  = require('express');
const axios    = require('axios');
const AdmZip   = require('adm-zip');
const iconv    = require('iconv-lite');
const fs       = require('fs');
const path     = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 환경변수 확인 ─────────────────────────────────────────
const DART_API_KEY   = process.env.DART_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!DART_API_KEY)   console.warn('⚠️  DART_API_KEY 미설정 — 검색/공시 기능 비활성화');
if (!GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY 미설정 — AI 요약 기능 비활성화');

// ── 정적 파일 서빙 ────────────────────────────────────────
app.use(express.static(__dirname));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
//  실시간 조회자 추적 (메인 화면 "지금 N명 조회중" 기능)
//  구조: corpCode → Map<sessionId, lastSeen(ms)>
//  세션이 3분 동안 heartbeat 없으면 자동 만료
// ═══════════════════════════════════════════════════════════
const activeViewers = new Map(); // corpCode → Map<sessionId, timestamp>
const VIEW_TIMEOUT  = 3 * 60 * 1000; // 3분

// 만료된 세션 정리 (30초마다)
setInterval(() => {
  const now = Date.now();
  for (const [corpCode, sessions] of activeViewers) {
    for (const [sid, ts] of sessions) {
      if (now - ts > VIEW_TIMEOUT) sessions.delete(sid);
    }
    if (sessions.size === 0) activeViewers.delete(corpCode);
  }
}, 30000);

// 조회 시작 / heartbeat
app.post('/api/view-start', (req, res) => {
  const { corpCode, sessionId } = req.body || {};
  if (!corpCode || !sessionId) return res.json({ ok: false });
  if (!activeViewers.has(corpCode)) activeViewers.set(corpCode, new Map());
  activeViewers.get(corpCode).set(sessionId, Date.now());
  res.json({ ok: true });
});

// 조회 종료
app.post('/api/view-end', (req, res) => {
  const { corpCode, sessionId } = req.body || {};
  if (corpCode && sessionId && activeViewers.has(corpCode)) {
    activeViewers.get(corpCode).delete(sessionId);
  }
  res.json({ ok: true });
});

// 현재 조회자 수 (인기 종목 목록 조회)
app.get('/api/view-counts', (req, res) => {
  const result = {};
  for (const [corpCode, sessions] of activeViewers) {
    if (sessions.size > 0) result[corpCode] = sessions.size;
  }
  res.json(result);
});

// ═══════════════════════════════════════════════════════════
//  Gemini 안전 필터 설정
//  DART 금융 공시 문서는 합법적 내용 — 보험 약관·재무표 등이
//  오탐(false positive)으로 PROHIBITED_CONTENT 처리되는 것을 방지
// ═══════════════════════════════════════════════════════════
const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
];

// ─────────────────────────────────────────────────────────
// 0. 상태 확인  GET /api/status
// ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    dart_key  : DART_API_KEY   ? '✅ 설정됨' : '❌ 없음',
    gemini_key: GEMINI_API_KEY ? '✅ 설정됨' : '❌ 없음',
    env       : process.env.VERCEL ? 'Vercel' : 'Local',
  });
});

// ─────────────────────────────────────────────────────────
// 0-B. DART 연결 테스트  GET /api/test?stock_code=005930
// ─────────────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const stockCode = (req.query.stock_code || '005930').trim();
  const t0 = Date.now();
  try {
    const { data } = await axios.get('https://opendart.fss.or.kr/api/company.json', {
      params: { crtfc_key: DART_API_KEY, stock_code: stockCode },
      timeout: 10000,
    });
    res.json({
      ok         : data.status === '000',
      dart_status: data.status,
      dart_msg   : data.message,
      corp_name  : data.corp_name,
      corp_code  : data.corp_code,
      elapsed_ms : Date.now() - t0,
      region     : process.env.VERCEL_REGION || process.env.AWS_REGION || 'unknown',
      dart_key_ok: !!DART_API_KEY,
    });
  } catch(e) {
    res.json({ ok: false, error: e.message, elapsed_ms: Date.now() - t0 });
  }
});

// ═══════════════════════════════════════════════════════════
//  모델 설정 — 나중에 수익이 나면 expert만 pro로 바꾸면 됨
//  변경 방법: 'gemini-1.5-flash' → 'gemini-1.5-pro'
// ═══════════════════════════════════════════════════════════
// ── 모델 설정 ──────────────────────────────────────────────
// 나중에 업그레이드하고 싶으면 아래 문자열만 바꾸면 됩니다:
//   현재 안정버전 → 'gemini-2.5-flash'
//   최신 고성능   → 'gemini-2.5-pro'
// ─────────────────────────────────────────────────────────
const GEMINI_MODELS = {
  general: 'gemini-2.5-flash',
  expert : 'gemini-2.5-flash',
  audit  : 'gemini-2.5-flash',
};
const GEMINI_TEMP = {
  general: 0.2,
  expert : 0.35,
  audit  : 0.2,
};

// ═══════════════════════════════════════════════════════════
//  서버 사이드 캐시 (파일 기반)
//  ─ A가 삼성전자 요약하면 summary_cache.json에 저장
//  ─ B가 같은 공시 요청하면 Gemini 안 쓰고 바로 반환
//  ─ 나중에 Firebase로 업그레이드할 때 saveToCache / getFromCache 2개 함수만 교체하면 됨
// ═══════════════════════════════════════════════════════════
// Vercel 서버리스는 __dirname 쓰기 불가 → /tmp 사용, 로컬은 __dirname 사용
const CACHE_FILE = process.env.VERCEL
  ? '/tmp/summary_cache.json'
  : path.join(__dirname, 'summary_cache.json');
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;  // 30일 (ms)

// 서버 시작 시 캐시 파일 로드
let summaryCache = {};
try {
  summaryCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const count = Object.keys(summaryCache).length;
  console.log(`[캐시] ${count}개 항목 로드됨`);
} catch {
  summaryCache = {};
}

function getFromCache(key) {
  const item = summaryCache[key];
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_MAX_AGE) {
    delete summaryCache[key];
    return null;
  }
  return item.data;
}

function saveToCache(key, data, meta = {}) {
  summaryCache[key] = { data, ts: Date.now(), ...meta };
  // 비동기 파일 저장 (서버 성능에 영향 없음)
  fs.writeFile(CACHE_FILE, JSON.stringify(summaryCache), () => {});
  console.log(`[캐시] 저장: ${key}`);
}

// ═══════════════════════════════════════════════════════════
//  공시한장 공식 시스템 프롬프트  (v1.0)
// ═══════════════════════════════════════════════════════════

const SYSTEM_GENERAL = `당신은 '공시한장' 서비스의 리포트 작성 AI입니다.
주식투자에 관심은 있지만 재무제표를 읽기 어려운 30~50대 일반인을 위해,
기업 사업보고서를 쉽고 흥미롭게 요약하는 것이 당신의 역할입니다.

[어조 및 문체]
- 중학생도 이해할 수 있는 쉬운 언어를 사용하십시오.
- 전문 용어가 나오면 반드시 괄호 안에 쉬운 설명을 붙이십시오. 예: HBM(AI 칩에 들어가는 고성능 메모리)
- 딱딱한 보고서 문체가 아닌, 친근하고 읽기 쉬운 설명체로 작성하십시오.
- 숫자는 반드시 '조', '억' 단위로 바꿔 쓰십시오. 예: 333,600,000,000,000원 → 333.6조원

[절대 금지]
- 투자 권유나 매수/매도 추천 표현을 사용하지 마십시오.
- 확인되지 않은 추측성 내용을 사실처럼 쓰지 마십시오.
- HTML 태그 외 마크다운 문법(##, ** 등) 금지.
- <html> <head> <body> <script> <style> 태그 금지.
- 코드블록(\`\`\`) 출력 금지. HTML을 바로 출력하십시오.

[사용 가능한 HTML 클래스 및 태그]
<div class='report fade'> / <div class='rkick'> / <h3> / <h4> /
<p class='lead'> / <p> / <ul> / <li> / <b> /
<table class='ftable'> <thead> <tbody> <tr> <th> <td> /
<div class='fin-divider'> / <div class='note'> /
<div class='verdict'> / <div class='vlbl'>

[재무 수치 작성 규칙 — 매우 중요]
- 원문에서 실제 숫자를 반드시 찾아 기재하십시오.
- 매출액 = 건설계약수익, 건설수익, 도급수익, 영업수익, 제품매출, 상품매출 모두 해당. 어떤 명칭이든 매출 최상위 항목을 찾으십시오.
- 재무제표(손익계산서), 요약 재무정보, 사업 실적 등 원문 어느 곳에서든 수치를 찾으십시오.
- 단위는 '조', '억'으로 변환하십시오. 예: 6,234,567백만원 → 6.2조원 / 234,567백만원 → 2,345억원
- "확인불가"는 원문 전체를 검토해도 해당 수치가 전혀 없을 때만 사용하십시오.
- 절대로 XX, XXX, X.X 같은 자리표시자를 출력에 사용하지 마십시오.

[출력 형식 — 반드시 아래 HTML 구조 그대로 출력. JSON 금지.]
<div class="report fade">
  <div class="rkick">AI 요약 · 일반인용 · Gemini 분석 · DART 공시 기반</div>
  <h3>[회사명] [보고서명]</h3>
  <p class="lead">[이 회사를 한 문장으로. 무엇으로 어떻게 돈을 버는지. 50자 내외.]</p>
  <h4>사업 구조 — 무엇으로 돈을 버나</h4>
  [2~3개의 &lt;p&gt; 문단. 각 2~4문장. 쉬운 말로.]
  <h4>성장성 — 앞으로 어디로</h4>
  [2개의 &lt;p&gt; 문단. 각 2~3문장.]
  <h4>리스크 — 무엇을 조심해야 하나</h4>
  <ul>[3개의 &lt;li&gt;. 각 한 문장씩.]</ul>
  <div class="verdict"><div class="vlbl">한 줄 결론</div><p>"[40자 내외. 투자 권유 없이.]"</p></div>
  <div class="fin-divider">
    <h4>주요 재무 지표</h4>
    <table class="ftable">
      <thead><tr><th>구분</th><th>[실제연도(제N기)]</th><th>[실제연도(제N기)]</th><th>[실제연도(제N기)]</th></tr></thead>
      <tbody>
        <tr><td>매출액</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td></tr>
        <tr><td>영업이익</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td></tr>
        <tr><td>영업이익률</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td></tr>
        <tr><td>당기순이익</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td><td>[원문의 실제 수치]</td></tr>
      </tbody>
    </table>
    <h4>핵심 주석</h4>
    <ul>[2개의 &lt;li&gt;. 각 2~3문장.]</ul>
    <h4>감사인 의견</h4>
    <div class="note">[감사인 의견과 KAM을 쉽게 설명. 2~3문장.]</div>
  </div>
</div>`;

// ── 감사보고서 전용 프롬프트 ─────────────────────────────
const SYSTEM_AUDIT = `당신은 '공시한장' 서비스의 감사보고서 요약 AI입니다.
외부 감사인(회계법인)이 작성한 감사보고서를 일반 투자자가 이해할 수 있도록 핵심만 뽑아 설명합니다.

[출력 형식 — 반드시 아래 HTML 구조 그대로 출력. JSON·마크다운 금지.]
<div class="report fade">
  <div class="rkick">AI 요약 · 감사보고서 · Gemini 분석 · DART 공시 기반</div>
  <h3>[회사명] 감사보고서 요약</h3>
  <p class="lead">[감사 의견 한 줄 요약: 예) "적정 의견 — 회계처리에 중요한 문제가 없음"]</p>

  <h4>감사 의견</h4>
  <p>[적정/한정/부적정/의견거절 여부와 그 이유를 쉬운 말로 설명. 한정·부적정이면 이유 강조.]</p>

  <h4>핵심 감사 사항 (KAM)</h4>
  <p>[감사인이 특별히 주의 깊게 들여다본 항목들. 없으면 "별도 핵심 감사 사항 없음"으로 표시.]</p>

  <h4>강조 사항</h4>
  <p>[계속기업 불확실성, 소송·우발부채, 합병·구조조정 등 중요 강조사항. 없으면 생략.]</p>

  <h4>재무 건전성 한눈에 보기</h4>
  <p>[감사보고서에서 확인할 수 있는 주요 재무 수치(자산, 부채, 자본, 당기순손익) 간략 정리.]</p>

  <div class="verdict">
    <div class="vlbl">투자자 핵심 체크포인트</div>
    <p>"[감사 의견·강조사항을 바탕으로 투자자가 주의해야 할 핵심 한 문장]"</p>
  </div>
</div>`;

const SYSTEM_EXPERT = `당신은 '공시한장' 서비스의 전문가용 리포트를 작성하는 시니어 애널리스트 AI입니다.
증권사 리서치 경험이 있는 주니어 애널리스트와 기관투자자에게 심층 분석 리포트를 제공하는 것이 당신의 역할입니다.

[어조 및 문체]
- 경험 많은 선배 애널리스트가 후배에게 설명하는 듯한 문체.
- "~이다."처럼 단정적으로. 중요한 숫자는 구체적으로 인용.
- 사업보고서에 없는 내용은 쓰지 말 것. 추측 금지.
- 중요 포인트는 <b>bold</b>로 강조.

[절대 금지]
- HTML 태그 외 마크다운 문법(##, ** 등) 금지.
- 투자 권유, 매수/매도 추천, 목표주가 금지.
- <html> <head> <body> <script> <style> 태그 금지.
- 추측을 사실처럼 쓰지 말 것.

[사용 가능한 HTML 클래스]
<div class='report fade'> / <div class='rkick'> / <h3> / <h4> /
<h4 style='font-size:17px; border-bottom:none; padding-bottom:0; margin-bottom:8px;'> /
<p class='lead'> / <p> / <ul> / <li> / <b> /
<table class='ftable'> <thead> <tbody> <tr> <th> <td> /
<td style='color:var(--up)'> (증가/개선) / <td style='color:var(--down)'> (감소/적자) /
<div class='note'> / <div class='verdict'> / <div class='vlbl'> / <div class='disclaimer'>

[출력 순서]
I. 이 회사를 이해하는 핵심 관점 (2~3가지)
II. 사업 구조 완전 해부 (테이블 + 설명)
III. 실적 완전 분석 (테이블 + YoY 분석)
IV. 핵심 사업부문 심층 분석 (소섹션 ①②③)
V. 재무제표 핵심 포인트 (테이블)
VI. 연구개발/투자 전략
VII. 핵심 리스크 (ul 목록)
VIII. 다음 연도 모니터링 포인트 3가지
결론 및 총평 (verdict 박스) + 면책 고지 (disclaimer)`;

// ─────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────
function yyyymmdd(date) { return date.toISOString().slice(0,10).replace(/-/g,''); }

// ─────────────────────────────────────────────────────────
// Gemini 503 재시도 헬퍼 (고수요 시 자동 재시도)
// ─────────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 4, baseDelayMs = 2000, onRetry) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || '';
      const is503 = msg.includes('503') || msg.includes('high demand') ||
                    msg.includes('overloaded') || msg.includes('UNAVAILABLE') ||
                    (err.status === 503);
      if (is503 && attempt < maxRetries - 1) {
        const delay = baseDelayMs * (attempt + 1);
        console.warn(`[Gemini] 503 재시도 ${attempt + 1}/${maxRetries} — ${delay}ms 대기 중...`);
        if (onRetry) onRetry(attempt + 1, maxRetries);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// 1-A. 회사 목록 검색  GET /api/companies?name=현대
//      ★ 빠른 경로: DART list.json 으로 1~2초 내 corp_code 조회
//      ★ 느린 경로: corpCode.xml 전체 다운로드 (폴백, /tmp 파일캐시 적용)
// ─────────────────────────────────────────────────────────
let _corpList    = null;   // 메모리 캐시
let _corpListAt  = 0;
const CORP_TTL        = 30 * 24 * 60 * 60 * 1000;   // 30일
const CORP_CACHE_FILE = '/tmp/corp_list.json';        // Vercel /tmp 파일캐시

// ── 빠른 경로: list.json 으로 corp_code 조회 (1~2초) ─────
async function quickCorpLookup(name) {
  const today      = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);

  const { data } = await axios.get('https://opendart.fss.or.kr/api/list.json', {
    params: {
      crtfc_key: DART_API_KEY,
      corp_name : name,
      bgn_de    : yyyymmdd(oneYearAgo),
      end_de    : yyyymmdd(today),
      sort      : 'date',
      sort_mth  : 'desc',
      page_count: 100,
    },
    timeout: 8000,
  });

  if (data.status !== '000' || !data.list) return [];

  // corp_code 기준 중복 제거
  const seen = new Set();
  const results = [];
  for (const item of data.list) {
    if (!seen.has(item.corp_code)) {
      seen.add(item.corp_code);
      results.push({
        corp_code : item.corp_code,
        corp_name : item.corp_name,
        stock_code: item.stock_code || '',
      });
    }
  }
  return results;
}

// ── 느린 경로: corpCode.xml 전체 다운로드 + /tmp 파일캐시 ─
async function getCorpList() {
  const now = Date.now();

  // ① 메모리 캐시
  if (_corpList && (now - _corpListAt) < CORP_TTL) return _corpList;

  // ② /tmp 파일캐시 (같은 Vercel 인스턴스 재실행 시 빠름)
  try {
    const fileData = JSON.parse(fs.readFileSync(CORP_CACHE_FILE, 'utf8'));
    if (fileData.ts && (now - fileData.ts) < CORP_TTL && Array.isArray(fileData.corps)) {
      _corpList   = fileData.corps;
      _corpListAt = fileData.ts;
      console.log('[corpCode.xml] /tmp 캐시 로드:', fileData.corps.length, '개');
      return _corpList;
    }
  } catch { /* 캐시 없음 — 계속 */ }

  // ③ DART 다운로드
  console.log('[corpCode.xml] 다운로드 시작...');
  const response = await axios.get('https://opendart.fss.or.kr/api/corpCode.xml', {
    params: { crtfc_key: DART_API_KEY },
    responseType: 'arraybuffer',
    timeout: 55000,
  });

  const zip    = new AdmZip(Buffer.from(response.data));
  const entry  = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
  const rawBuf = entry.getData();

  // UTF-8 먼저 시도, 깨지면 EUC-KR
  let xml;
  try {
    xml = rawBuf.toString('utf-8');
    if (xml.includes('�')) xml = iconv.decode(rawBuf, 'euc-kr');
  } catch { xml = iconv.decode(rawBuf, 'euc-kr'); }

  console.log('[corpCode.xml] XML 크기:', xml.length, '자');

  // indexOf 방식 파싱
  const corps = [];
  const parts  = xml.split('<list>');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const get = (tag) => {
      const open  = '<'  + tag + '>';
      const close = '</' + tag + '>';
      const s = block.indexOf(open);
      const e = block.indexOf(close);
      return (s >= 0 && e > s) ? block.slice(s + open.length, e).trim() : '';
    };
    const corp_code  = get('corp_code');
    const corp_name  = get('corp_name');
    const stock_code = get('stock_code');
    if (corp_code && corp_name) corps.push({ corp_code, corp_name, stock_code });
  }

  // /tmp 파일캐시 저장 (다음 cold start에 재사용)
  try {
    fs.writeFileSync(CORP_CACHE_FILE, JSON.stringify({ ts: now, corps }));
    console.log('[corpCode.xml] /tmp 캐시 저장 완료');
  } catch (e) {
    console.warn('[corpCode.xml] /tmp 캐시 저장 실패:', e.message);
  }

  _corpList   = corps;
  _corpListAt = now;
  console.log('[corpCode.xml]', corps.length, '개 로드 완료 | 샘플:', corps.slice(0,3).map(c=>c.corp_name).join(', '));
  return corps;
}

// 결과 정렬 헬퍼 (대소문자 무시)
function sortCorps(list, name) {
  const nl = name.toLowerCase();
  const exact   = list.filter(c => c.corp_name.toLowerCase() === nl);
  const starts  = list.filter(c => c.corp_name.toLowerCase() !== nl && c.corp_name.toLowerCase().startsWith(nl));
  const partial = list.filter(c => !c.corp_name.toLowerCase().startsWith(nl) && c.corp_name.toLowerCase().includes(nl));
  const sort    = arr => arr.sort((a,b) => a.corp_name.localeCompare(b.corp_name, 'ko'));
  return [...exact, ...sort(starts), ...sort(partial)].slice(0, 30);
}

app.get('/api/companies', async (req, res) => {
  const name      = (req.query.name       || '').trim();
  const stockCode = (req.query.stock_code || '').trim();
  if (!name && !stockCode) return res.json([]);
  if (!DART_API_KEY) return res.status(500).json({ error: 'DART_API_KEY가 설정되지 않았습니다.' });

  try {
    // ── ① 최우선: stock_code + 이름 앞글자로 list.json 검색 후 stock_code 필터 ─
    //    DART에 stock_code→corp_code 직접 API 없음 → 이름 2글자 prefix + stock_code 매칭
    if (stockCode && stockCode.length === 6 && name) {
      try {
        // 이름 앞 2~3글자로 넓게 검색 → stock_code 일치 항목 추출
        const prefix = name.slice(0, name.length >= 3 ? 3 : 2);
        const quick  = await quickCorpLookup(prefix);
        const match  = quick.find(c => c.stock_code === stockCode);
        if (match) {
          console.log('[/api/companies stock_code match]', stockCode, '=>', match.corp_name, match.corp_code);
          return res.json([match]);
        }
        // prefix 검색에 없으면 2글자로 재시도 (예: '현대차' → '현대' 검색)
        if (prefix.length > 2) {
          const quick2 = await quickCorpLookup(name.slice(0, 2));
          const match2 = quick2.find(c => c.stock_code === stockCode);
          if (match2) {
            console.log('[/api/companies stock_code match2]', stockCode, '=>', match2.corp_name, match2.corp_code);
            return res.json([match2]);
          }
        }
      } catch (e) {
        console.warn('[/api/companies stock_code prefix] 실패:', e.message);
      }
    }

    if (!name) return res.json([]);

    // ── ② 빠른 경로: list.json 이름 검색 (1~2초) ─────────
    let results = [];
    try {
      const quick = await quickCorpLookup(name);
      results = sortCorps(quick, name);
      console.log('[/api/companies fast]', name, '→', results.length, '개');
    } catch (e) {
      console.warn('[/api/companies fast] 실패, 전체 검색으로 폴백:', e.message);
    }

    // ── ③ 결과 없으면 corpCode.xml 폴백 (대소문자 무시 부분일치) ──
    if (results.length === 0) {
      const corps = await getCorpList();
      const nl = name.toLowerCase();
      results = sortCorps(corps.filter(c => c.corp_name.toLowerCase().includes(nl)), name);
      console.log('[/api/companies full]', name, '→', results.length, '개');
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: '회사 목록 로드 실패', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// 1. 회사명 검색  GET /api/search?name=삼성전자
// ─────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const name      = (req.query.name       || '').trim();
  const corpCode  = (req.query.corpCode   || '').trim();  // corp_code 있으면 우선 사용
  const pageCount = parseInt(req.query.page_count || '100', 10);
  if (!name && !corpCode) return res.status(400).json({ error: '검색어를 입력해 주세요.' });

  if (!DART_API_KEY) return res.status(500).json({ error: 'DART_API_KEY가 설정되지 않았습니다.' });

  const today = new Date();

  // corp_code로 검색: 1년치 가능
  // corp_name만으로 검색: DART 규칙상 최대 3개월
  let params;
  if (corpCode) {
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    params = { crtfc_key: DART_API_KEY, corp_code: corpCode,
               bgn_de: yyyymmdd(oneYearAgo), end_de: yyyymmdd(today),
               sort: 'date', sort_mth: 'desc', page_count: pageCount };
  } else {
    const threeMonthsAgo = new Date(today);
    threeMonthsAgo.setMonth(today.getMonth() - 3);
    params = { crtfc_key: DART_API_KEY, corp_name: name,
               bgn_de: yyyymmdd(threeMonthsAgo), end_de: yyyymmdd(today),
               sort: 'date', sort_mth: 'desc', page_count: pageCount };
  }

  try {
    const { data } = await axios.get('https://opendart.fss.or.kr/api/list.json', { params });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'DART 검색 오류', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// 2. 기업 공시 목록  GET /api/disclosures?corpCode=00126380
// ─────────────────────────────────────────────────────────
app.get('/api/disclosures', async (req, res) => {
  const corpCode = (req.query.corpCode || '').trim();
  const months    = parseInt(req.query.months     || '3',   10);  // 기본 3개월
  const pageCount = parseInt(req.query.page_count || '100', 10);  // 기본 100 (DART 최대)
  if (!corpCode) return res.status(400).json({ error: 'corpCode가 필요해요.' });

  const today   = new Date();
  const fromDate = new Date(today);
  fromDate.setMonth(today.getMonth() - months);

  try {
    const { data } = await axios.get('https://opendart.fss.or.kr/api/list.json', {
      params: { crtfc_key: DART_API_KEY, corp_code: corpCode,
                bgn_de: yyyymmdd(fromDate), end_de: yyyymmdd(today),
                sort: 'date', sort_mth: 'desc', page_count: pageCount }
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '공시 목록 오류', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// 3. 공시 AI 요약  GET /api/summarize?rcptNo=...&mode=general|expert
//    ★ 서버 캐시 우선 확인 — 이미 누군가 요약한 적 있으면 Gemini 안 씀
// ─────────────────────────────────────────────────────────
app.get('/api/summarize', async (req, res) => {
  const rcptNo   = (req.query.rcptNo   || '').trim();
  const mode     = (req.query.mode     || 'general').trim();
  const corpName = (req.query.corpName || '이 기업').trim();
  const year     = (req.query.year     || '').trim();
  const term     = (req.query.term     || '').trim();

  if (!rcptNo) return res.status(400).json({ error: 'rcptNo가 필요해요.' });

  // ── ① 서버 캐시 확인 ─────────────────────────────────
  const cacheKey = `${rcptNo}_${mode}_v6`;
  const cached   = getFromCache(cacheKey);
  if (cached) {
    console.log(`[/api/summarize] ✨ 캐시 히트: ${cacheKey}`);
    return res.json({ mode, data: cached, rcptNo, fromCache: true });
  }

  // ── ② DART 문서 ZIP 다운로드 ─────────────────────────
  console.log(`[/api/summarize] DART 다운로드... rcptNo=${rcptNo}`);
  let docText = '';
  try {
    const docRes = await axios.get('https://opendart.fss.or.kr/api/document.xml', {
      params: { crtfc_key: DART_API_KEY, rcept_no: rcptNo },
      responseType: 'arraybuffer', timeout: 30000
    });

    // ZIP 매직바이트 검증 (PK\x03\x04)
    const docBuf = Buffer.from(docRes.data);
    if (docBuf.length < 4 || docBuf[0] !== 0x50 || docBuf[1] !== 0x4B) {
      const preview = docBuf.toString('utf-8').slice(0, 120).replace(/[\r\n]+/g,' ');
      throw new Error('ZIP 형식 아님 — DART가 오류 페이지를 반환했을 수 있어요: ' + preview);
    }
    const zip = new AdmZip(docBuf);
    let rawText = '';
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const buf = entry.getData();
      let content;
      try {
        content = iconv.decode(buf, 'utf-8');
        if (content.includes('')) content = iconv.decode(buf, 'euc-kr');
      } catch { content = buf.toString('utf-8'); }

      // 테이블 구조 보존: tr → 줄바꿈, td/th → 탭 구분
      let c = content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi,  '');
      // 테이블 셀을 탭으로, 행을 줄바꿈으로
      c = c
        .replace(/<\/tr>/gi, '\n')
        .replace(/<tr[^>]*>/gi, '')
        .replace(/<\/t[hd]>/gi, '\t')
        .replace(/<t[hd][^>]*>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
        .replace(/\t[ \t]+/g,'\t').replace(/[ ]{3,}/g,' ')
        .replace(/\n{3,}/g,'\n\n').trim();
      rawText += c + '\n\n';
    }

    // 재무제표는 문서 뒷부분에 있으므로 앞 + 뒤를 모두 포함
    const MAX_FRONT = mode === 'expert' ? 18000 : 14000;
    const MAX_BACK  = mode === 'expert' ?  8000 :  6000;
    if (rawText.length > MAX_FRONT + MAX_BACK) {
      docText = rawText.slice(0, MAX_FRONT) +
                '\n\n[... 중략 ...]\n\n' +
                rawText.slice(rawText.length - MAX_BACK);
    } else {
      docText = rawText;
    }

    if (!docText.trim()) return res.status(422).json({ error: '텍스트 추출 실패' });

  } catch (err) {
    return res.status(500).json({ error: 'DART 문서 다운로드 실패', detail: err.message });
  }

  // ── ③ Gemini 호출 ────────────────────────────────────
  const modelName = GEMINI_MODELS[mode] || GEMINI_MODELS.general;
  const temp      = GEMINI_TEMP[mode]   || 0.2;
  console.log(`[/api/summarize] Gemini 호출... model=${modelName} (${docText.length}자)`);

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model            : modelName,
      systemInstruction: mode === 'expert' ? SYSTEM_EXPERT : mode === 'audit' ? SYSTEM_AUDIT : SYSTEM_GENERAL,
      generationConfig : { temperature: temp, topP: 0.8, maxOutputTokens: mode === 'expert' ? 8192 : 6000 },
      safetySettings   : GEMINI_SAFETY,
    });

    const userMsg = `다음 사업보고서를 분석하여 ${mode === 'expert' ? '전문가용 HTML' : '일반인용 HTML'} 리포트를 작성해주세요.

[회사명]: ${corpName}
[기준 사업연도]: ${year || '최근 사업연도'} (${term || ''})

[사업보고서 원문]:
${docText}`;

    const result = await withRetry(() => model.generateContent(userMsg));
    let   output = result.response.text();

    // 코드블록 래핑 제거 (```html, ```json 등)
    output = output.replace(/^```(?:html|json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // ── ④ 서버 캐시에 저장 (다음 사용자는 즉시 반환) ──
    saveToCache(cacheKey, output, { corpName, mode });

    console.log(`[/api/summarize] ✅ 완료: ${cacheKey}`);
    res.json({ mode, data: output, rcptNo, fromCache: false });

  } catch (err) {
    console.error('[/api/summarize] Gemini 오류:', err.message);
    res.status(500).json({ error: 'AI 요약 오류', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// 헬퍼: 재무제표에서 핵심 수치 행만 미리 추출
//  압축 후에도 Gemini가 실제 숫자를 정확히 쓸 수 있도록
//  주요 재무 지표 행을 문서 앞부분에 따로 주입
//
//  DART 문서 구조 특성:
//    "Ⅱ. 영업수익(매출액)" — 키워드 행에 숫자 없음
//    "합계   3,500,000   3,200,000" — 숫자는 이후 행에 있음
//  → 키워드 발견 후 최대 8행 안에서 숫자 행 탐색
// ─────────────────────────────────────────────────────────
function extractKeyFinancials(rawText) {
  // 찾을 재무 지표 (우선순위 순)
  const TARGETS = [
    { key: '매출액',    keywords: ['매출액', '영업수익', '순매출액', '건설계약수익', '건설수익', '도급수익', '수주매출', '제품매출', '상품매출', '매출 합계', '수익 합계', '총수익'] },
    { key: '영업이익',  keywords: ['영업이익', '영업손익', '영업이익(손실)', '영업손실', '영업이익(손실)'] },
    { key: '당기순이익', keywords: ['당기순이익', '당기순손익', '당기순이익(손실)', '분기순이익', '반기순이익', '당기순손실', '지배기업 소유주 지분'] },
    { key: '영업이익률', keywords: ['영업이익률'] },
    { key: '자산총계',  keywords: ['자산총계', '자산 합계'] },
    { key: '부채총계',  keywords: ['부채총계', '부채 합계'] },
    { key: '자본총계',  keywords: ['자본총계', '자본 합계'] },
  ];
  const YEAR_RE   = /제\s*\d+\s*기/;
  const NUM_RE    = /^[\-\(]?[\d][\d,\.]*[\)]?$/; // 숫자셀 판별

  // 숫자 셀이 2개 이상인지 확인
  function getNumCells(line) {
    return line.split('\t').map(s => s.trim())
      .filter(s => NUM_RE.test(s) && s.replace(/[\-\(\),\.]/g, '').length >= 2);
  }

  const lines      = rawText.split('\n');
  const found      = {};   // key → "label\t숫자\t숫자\t..."
  let   headerLine = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 연도 헤더 탐지 (예: "구분\t제53기\t제52기\t제51기")
    if (YEAR_RE.test(line) && line.includes('\t') && !headerLine) {
      const cells = line.split('\t').map(s => s.trim()).filter(Boolean);
      if (cells.length >= 3) { headerLine = line.trim(); }
      continue;
    }

    for (const { key, keywords } of TARGETS) {
      if (found[key]) continue;

      for (const kw of keywords) {
        if (!line.includes(kw)) continue;

        // ① 같은 줄에 숫자가 있으면 바로 채택
        const sameLine = getNumCells(line);
        if (sameLine.length >= 2) {
          found[key] = line.trim();
          break;
        }

        // ② 키워드 행에 숫자 없으면 이후 최대 25행 안에서 탐색
        //    숫자 셀이 가장 많은 행을 합계 행으로 채택
        let bestLine = '';
        let bestNumCount = 0;
        // 중단 기준: 다른 '상위' 재무 지표(매출액/영업이익/당기순이익/자산총계 등)가 나올 때만
        const STOP_KWS = ['영업이익', '당기순이익', '매출총이익', '자산총계', '매출원가'];
        for (let j = i + 1; j < Math.min(i + 26, lines.length); j++) {
          const nc = getNumCells(lines[j]);
          if (nc.length >= 2 && nc.length > bestNumCount) {
            bestLine = lines[j].trim();
            bestNumCount = nc.length;
          }
          if (j > i + 3 && STOP_KWS.some(k => lines[j].includes(k))) break;
        }
        if (bestLine && bestNumCount >= 2) found[key] = `${kw}\t${bestLine.replace(/^[^\t]*\t/, '')}`;
        break;
      }
    }

    // 주요 4개 지표 확보되면 조기 종료
    if (found['매출액'] && found['영업이익'] && found['당기순이익']) break;
  }

  if (Object.keys(found).length === 0) return '';

  const hdr   = headerLine ? headerLine + '\n' : '';
  const rows  = Object.values(found).join('\n');
  return `[★ 핵심 재무 수치 — 아래 실제 숫자를 반드시 요약에 사용하세요. XX·XXX 플레이스홀더 절대 금지 ★]\n${hdr}${rows}\n`;
}

// ─────────────────────────────────────────────────────────
// 헬퍼: DART 문서 ZIP → 텍스트 추출 (두 엔드포인트 공용)
// ─────────────────────────────────────────────────────────
async function fetchDartDocText(rcptNo, mode) {
  const docRes = await axios.get('https://opendart.fss.or.kr/api/document.xml', {
    params: { crtfc_key: DART_API_KEY, rcept_no: rcptNo },
    responseType: 'arraybuffer', timeout: 35000,
  });
  const docBuf = Buffer.from(docRes.data);
  if (docBuf.length < 4 || docBuf[0] !== 0x50 || docBuf[1] !== 0x4B) {
    const preview = docBuf.toString('utf-8').slice(0, 120).replace(/[\r\n]+/g, ' ');
    throw new Error('ZIP 형식 아님 — DART가 오류 페이지를 반환했을 수 있어요: ' + preview);
  }
  const zip = new AdmZip(docBuf);
  let rawText = '';
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const buf = entry.getData();
    let content;
    try {
      content = iconv.decode(buf, 'utf-8');
      if (content.includes('')) content = iconv.decode(buf, 'euc-kr');
    } catch { content = buf.toString('utf-8'); }
    let c = content
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi,  '');
    c = c
      .replace(/<\/tr>/gi, '\n').replace(/<tr[^>]*>/gi, '')
      .replace(/<\/t[hd]>/gi, '\t').replace(/<t[hd][^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .replace(/\t[ \t]+/g,'\t').replace(/[ ]{3,}/g,' ')
      .replace(/\n{3,}/g,'\n\n').trim();
    rawText += c + '\n\n';
  }
  // ① 핵심 재무 수치 미리 추출 (압축 전 — Gemini가 정확한 숫자를 쓰도록)
  const keyFinancials = extractKeyFinancials(rawText);

  // ① - B 손익계산서 섹션 직접 추출 (중략 구간에 있어도 반드시 Gemini에 전달)
  //   '포괄손익계산서' 또는 '손익계산서' 키워드의 두 번째 등장 위치부터 5000자 추출
  //   (첫 번째는 목차에 언급, 두 번째가 실제 재무제표 본문)
  let incomeSection = '';
  const IS_KEYWORDS = ['포괄손익계산서', '손익계산서', '영업수익\t', '매출액\t'];
  for (const kw of IS_KEYWORDS) {
    const idx1 = rawText.indexOf(kw);
    if (idx1 < 0) continue;
    const idx2 = rawText.indexOf(kw, idx1 + kw.length + 10);
    const startIdx = idx2 >= 0 ? idx2 : idx1;
    incomeSection = rawText.slice(Math.max(0, startIdx - 300), Math.min(rawText.length, startIdx + 5000));
    if (incomeSection.length > 200) break;
  }

  // ② RECITATION 방지 압축 (탭 구분 숫자 9개↑ 연속만 압축 → 연결+별도 각 3년치=6개도 살아남음)
  const compressed = rawText
    .replace(/(\t[\d,\.\-\(\)]+){9,}/g, '\t[재무수치 생략]')
    .replace(/\n{3,}/g, '\n\n');

  const MAX_FRONT = mode === 'expert' ? 16000 : 12000;
  const MAX_BACK  = mode === 'expert' ?  9000 :  6000;
  let docBody;
  if (compressed.length > MAX_FRONT + MAX_BACK) {
    docBody = compressed.slice(0, MAX_FRONT) + '\n\n[... 중략 ...]\n\n' + compressed.slice(compressed.length - MAX_BACK);
  } else {
    docBody = compressed;
  }

  // ③ 핵심 재무 수치 + 손익계산서 섹션을 문서 앞에 주입
  //   손익계산서 섹션이 이미 docBody에 포함된 경우 중복 주입 방지
  let preamble = '';
  if (keyFinancials) preamble += keyFinancials + '\n\n';
  if (incomeSection && !docBody.includes(incomeSection.slice(50, 150))) {
    preamble += '[손익계산서 발췌 — 재무수치 확인용]\n' + incomeSection + '\n\n';
  }
  return preamble + docBody;
}

// ─────────────────────────────────────────────────────────
// 3-B. AI 요약 스트리밍  GET /api/summarize-stream
//      SSE(text/event-stream)로 Gemini 청크를 실시간 전송
//      이벤트: progress | chunk | done | cached | error
// ─────────────────────────────────────────────────────────
app.get('/api/summarize-stream', async (req, res) => {
  const rcptNo   = (req.query.rcptNo   || '').trim();
  const mode     = (req.query.mode     || 'general').trim();
  const corpName = (req.query.corpName || '이 기업').trim();
  const year     = (req.query.year     || '').trim();
  const term     = (req.query.term     || '').trim();

  if (!rcptNo) return res.status(400).json({ error: 'rcptNo가 필요해요.' });

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch(_) {} };

  // ── ① 캐시 확인 ──────────────────────────────────────────
  const cacheKey = `${rcptNo}_${mode}_v6`;
  const cached   = getFromCache(cacheKey);
  if (cached) {
    console.log(`[stream] 캐시 히트: ${cacheKey}`);
    send({ type: 'cached', data: cached });
    return res.end();
  }

  // ── ② DART 문서 다운로드 ─────────────────────────────────
  send({ type: 'progress', msg: '📥 DART 문서 다운로드 중...' });
  let docText = '';
  try {
    docText = await fetchDartDocText(rcptNo, mode);
    if (!docText.trim()) {
      send({ type: 'error', msg: '텍스트 추출 실패' });
      return res.end();
    }
    send({ type: 'progress', msg: '🤖 AI가 분석하고 있어요...' });
  } catch (err) {
    send({ type: 'error', msg: 'DART 문서 다운로드 실패: ' + err.message });
    return res.end();
  }

  // ── ③ Gemini 스트리밍 호출 ───────────────────────────────
  const modelName = GEMINI_MODELS[mode] || GEMINI_MODELS.general;
  const temp      = GEMINI_TEMP[mode]   || 0.2;
  const userMsg   = `다음 사업보고서를 분석하여 ${mode === 'expert' ? '전문가용 HTML' : '일반인용 HTML'} 리포트를 작성해주세요.\n\n[회사명]: ${corpName}\n[기준 사업연도]: ${year || '최근 사업연도'} (${term || ''})\n\n[사업보고서 원문]:\n${docText}`;

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model            : modelName,
      systemInstruction: mode === 'expert' ? SYSTEM_EXPERT : mode === 'audit' ? SYSTEM_AUDIT : SYSTEM_GENERAL,
      generationConfig : { temperature: temp, topP: 0.8, maxOutputTokens: mode === 'expert' ? 6000 : 6000 },
      safetySettings   : GEMINI_SAFETY,
    });

    const streamResult = await withRetry(
      () => model.generateContentStream(userMsg),
      3, 1000,
      (attempt, max) => send({ type: 'progress', msg: `🤖 AI가 열심히 분석하고 있어요... (${attempt}/${max})` })
    );
    let fullText = '';
    let blockedChunks = 0;

    for await (const chunk of streamResult.stream) {
      try {
        const text = chunk.text();
        if (text) {
          fullText += text;
          send({ type: 'chunk', text });
        }
      } catch (chunkErr) {
        // PROHIBITED_CONTENT / RECITATION 등 특정 청크만 차단된 경우 → 스킵하고 계속
        const msg = chunkErr.message || '';
        if (msg.includes('PROHIBITED_CONTENT') || msg.includes('RECITATION') || msg.includes('blocked')) {
          blockedChunks++;
          console.warn(`[stream] 청크 ${blockedChunks}개 차단 — 스킵 후 계속`);
          continue; // 다음 청크 계속 수신
        }
        throw chunkErr; // 다른 오류는 상위 catch로
      }
    }

    // 이미 충분한 내용이 쌓였으면 (300자↑) → 부분 결과라도 완료 처리
    if (fullText.length < 100) {
      send({ type: 'error', msg: `응답이 전부 차단됐어요. 잠시 후 다시 시도해 주세요. (차단 청크: ${blockedChunks}개)` });
      res.end();
      return;
    }

    // 코드블록 래핑 제거 (```html, ```json 등)
    const cleanedOutput = fullText.replace(/^```(?:html|json)?\s*/i, '').replace(/\s*```$/, '').trim();

    saveToCache(cacheKey, cleanedOutput, { corpName, mode });
    send({ type: 'done', data: cleanedOutput });
    console.log(`[stream] ✅ 완료: ${cacheKey} (차단 청크: ${blockedChunks}개)`);
    res.end();

  } catch (err) {
    const errMsg = err.message || '';
    // PROHIBITED_CONTENT가 초기 연결 단계에서 발생한 경우
    if (errMsg.includes('PROHIBITED_CONTENT') || errMsg.includes('RECITATION')) {
      console.warn('[stream] 전체 차단 — 문서 길이 줄여서 재시도 불가 (이미 최소화됨)');
      send({ type: 'error', msg: 'AI 필터에 걸렸어요. 잠시 후 다시 시도해 주세요.' });
    } else {
      console.error('[stream] 오류:', errMsg);
      send({ type: 'error', msg: 'AI 요약 오류: ' + errMsg });
    }
    res.end();
  }
});

// ─────────────────────────────────────────────────────────
// 4. 보고서 없는 기업 — Gemini 일반지식 요약
//    DART 문서 없이 회사명만으로 간단 요약 생성
// ─────────────────────────────────────────────────────────
app.get('/api/no-report-summary', async (req, res) => {
  const corpName = (req.query.corpName || '').trim();
  if (!corpName) return res.status(400).json({ error: '기업명이 필요해요.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY 미설정' });

  const cacheKey = 'noreport_' + corpName + '_general';
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log('[/api/no-report-summary] 캐시 히트:', corpName);
    return res.json({ data: cached, fromCache: true, noReport: true });
  }

  console.log('[/api/no-report-summary] Gemini 일반지식 요약:', corpName);
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `당신은 기업 분석 AI입니다.
DART 공시 원문 없이 학습 데이터만으로 기업 개요를 작성합니다.
반드시 JSON만 출력하세요. 마크다운 코드블록 금지.
모르는 내용은 추측하지 말고 "정보 없음"으로 표시하세요.`,
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      safetySettings  : GEMINI_SAFETY,
    });

    const prompt = `${corpName}에 대해 알고 있는 정보로 아래 JSON 형식으로 작성해주세요.
공시 원문이 없으므로 재무 수치는 최대한 정확하게 기재하되 불확실하면 "확인필요"로 표시하세요.

{
  "lead": "한 문장 기업 소개 (50자 내외)",
  "structure": ["사업 구조 문단 1", "사업 구조 문단 2"],
  "growth": ["성장 포인트 1", "성장 포인트 2"],
  "risk": ["리스크 1", "리스크 2", "리스크 3"],
  "verdict": "한 줄 결론 (40자 내외)",
  "fin": [
    ["구분", "최근 연도(추정)"],
    ["매출액", "확인필요"],
    ["영업이익", "확인필요"],
    ["영업이익률", "확인필요"],
    ["당기순이익", "확인필요"]
  ],
  "notes": ["⚠️ 공시 원문 미확인 — AI 학습 데이터 기반 요약입니다. 투자 결정 전 반드시 DART 원문을 확인하세요."],
  "audit": "공시 원문 없음 — 감사 정보를 확인할 수 없습니다."
}`;

    const result = await withRetry(() => model.generateContent(prompt));
    let output = result.response.text()
      .replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

    saveToCache(cacheKey, output, { corpName });
    res.json({ data: output, fromCache: false, noReport: true });
  } catch(err) {
    console.error('[/api/no-report-summary] 오류:', err.message);
    res.status(500).json({ error: 'AI 요약 오류', detail: err.message });
  }
});


// ── 캐시 현황 조회 (개발/운영 확인용)  GET /api/cache-stats
app.get('/api/cache-stats', (req, res) => {
  const keys  = Object.keys(summaryCache);
  const total = keys.length;
  const byMode = { general: 0, expert: 0 };
  keys.forEach(k => { if(k.endsWith('_general')) byMode.general++; if(k.endsWith('_expert')) byMode.expert++; });
  res.json({ total, byMode, keys: keys.slice(0, 20) });
});

// ── 서버 시작 ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n✅  공시한장 서버 실행 중!');
  console.log(`   브라우저: http://localhost:${PORT}`);
  console.log(`   캐시 현황: http://localhost:${PORT}/api/cache-stats\n`);
});
