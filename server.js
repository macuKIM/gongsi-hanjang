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

// ═══════════════════════════════════════════════════════════
//  모델 설정 — 나중에 수익이 나면 expert만 pro로 바꾸면 됨
//  변경 방법: 'gemini-1.5-flash' → 'gemini-1.5-pro'
// ═══════════════════════════════════════════════════════════
// ── 모델 설정 ──────────────────────────────────────────────
// 나중에 업그레이드하고 싶으면 아래 문자열만 바꾸면 됩니다:
//   현재 안정버전 → 'gemini-2.0-flash'
//   최신 고성능   → 'gemini-2.5-flash-preview-05-20'
// ─────────────────────────────────────────────────────────
const GEMINI_MODELS = {
  general: 'gemini-2.0-flash',   // 일반인용 — 빠르고 저렴
  expert : 'gemini-2.0-flash',   // 전문가용 — 수익 나면 'gemini-2.5-flash-preview-05-20' 으로 변경
};
const GEMINI_TEMP = {
  general: 0.2,
  expert : 0.35,
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
- 각 항목은 2~3문단 이내로 간결하게 유지하십시오.

[절대 금지]
- JSON 외 다른 텍스트(설명, 인사, 마크다운 코드블록 등)를 절대 출력하지 마십시오.
- 투자 권유나 매수/매도 추천 표현을 사용하지 마십시오.
- 확인되지 않은 추측성 내용을 사실처럼 쓰지 마십시오.
- 같은 내용을 여러 항목에 중복해서 쓰지 마십시오.

[출력 형식 — 반드시 이 JSON 구조만 출력]
{
  "lead": "이 회사를 한 문장으로. 무엇으로 어떻게 돈을 버는지. 50자 내외.",
  "structure": ["사업 구조 문단 1 (2~4문장)", "사업 구조 문단 2 (2~4문장)"],
  "growth": ["성장성 문단 1 (2~3문장)", "성장성 문단 2 (2~3문장)"],
  "risk": ["리스크 1 (한 문장)", "리스크 2 (한 문장)", "리스크 3 (한 문장)"],
  "verdict": "한 줄 결론. 투자 권유 없이. 40자 내외. 큰따옴표 없이.",
  "fin": [
    ["구분", "20XX(제XX기)", "20XX(제XX기)", "20XX(제XX기)"],
    ["매출액", "XXX조", "XXX조", "XXX조"],
    ["영업이익", "XX조", "XX조", "XX조"],
    ["영업이익률", "X.X%", "X.X%", "X.X%"],
    ["당기순이익", "XX조", "XX조", "XX조"]
  ],
  "notes": ["주석 핵심 사항 1 (2~3문장)", "주석 핵심 사항 2 (2~3문장)"],
  "audit": "감사인 의견과 KAM 쉽게 설명 (2~3문장)"
}`;

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

// 결과 정렬 헬퍼
function sortCorps(list, name) {
  const exact   = list.filter(c => c.corp_name === name);
  const starts  = list.filter(c => c.corp_name !== name && c.corp_name.startsWith(name));
  const partial = list.filter(c => !c.corp_name.startsWith(name) && c.corp_name.includes(name));
  const sort    = arr => arr.sort((a,b) => a.corp_name.localeCompare(b.corp_name, 'ko'));
  return [...exact, ...sort(starts), ...sort(partial)].slice(0, 30);
}

app.get('/api/companies', async (req, res) => {
  const name      = (req.query.name       || '').trim();
  const stockCode = (req.query.stock_code || '').trim();
  if (!name && !stockCode) return res.json([]);
  if (!DART_API_KEY) return res.status(500).json({ error: 'DART_API_KEY가 설정되지 않았습니다.' });

  try {
    // ── ① 최우선: stock_code → company.json (0.5초, 가장 정확) ─
    if (stockCode && stockCode.length === 6) {
      try {
        const { data } = await axios.get('https://opendart.fss.or.kr/api/company.json', {
          params: { crtfc_key: DART_API_KEY, stock_code: stockCode },
          timeout: 5000,
        });
        if (data.status === '000' && data.corp_code) {
          console.log('[/api/companies stock_code]', stockCode, '=>', data.corp_name, data.corp_code);
          return res.json([{ corp_code: data.corp_code, corp_name: data.corp_name, stock_code: data.stock_code }]);
        }
      } catch (e) {
        console.warn('[/api/companies stock_code] 실패:', e.message);
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

    // ── ③ 결과 없으면 corpCode.xml 폴백 ──────────────────
    if (results.length === 0) {
      const corps = await getCorpList();
      results = sortCorps(corps.filter(c => c.corp_name.includes(name)), name);
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
  const name     = (req.query.name     || '').trim();
  const corpCode = (req.query.corpCode || '').trim();  // corp_code 있으면 우선 사용
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
               sort: 'date', sort_mth: 'desc', page_count: 30 };
  } else {
    const threeMonthsAgo = new Date(today);
    threeMonthsAgo.setMonth(today.getMonth() - 3);
    params = { crtfc_key: DART_API_KEY, corp_name: name,
               bgn_de: yyyymmdd(threeMonthsAgo), end_de: yyyymmdd(today),
               sort: 'date', sort_mth: 'desc', page_count: 30 };
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
  const months   = parseInt(req.query.months || '3', 10);  // 기본 3개월, 1년치는 12 전달
  if (!corpCode) return res.status(400).json({ error: 'corpCode가 필요해요.' });

  const today   = new Date();
  const fromDate = new Date(today);
  fromDate.setMonth(today.getMonth() - months);

  try {
    const { data } = await axios.get('https://opendart.fss.or.kr/api/list.json', {
      params: { crtfc_key: DART_API_KEY, corp_code: corpCode,
                bgn_de: yyyymmdd(fromDate), end_de: yyyymmdd(today),
                sort: 'date', sort_mth: 'desc', page_count: 30 }
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
  const cacheKey = `${rcptNo}_${mode}`;
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

    const zip = new AdmZip(Buffer.from(docRes.data));
    let rawText = '';
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const buf = entry.getData();
      let content;
      try {
        content = iconv.decode(buf, 'utf-8');
        if (content.includes('')) content = iconv.decode(buf, 'euc-kr');
      } catch { content = buf.toString('utf-8'); }

      rawText += content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi,  '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
        .replace(/\s{2,}/g,' ').trim() + '\n\n';
    }

    const MAX  = mode === 'expert' ? 15000 : 12000;
    docText    = rawText.length > MAX ? rawText.slice(0, MAX) + '\n\n[... 이하 생략 ...]' : rawText;

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
      systemInstruction: mode === 'expert' ? SYSTEM_EXPERT : SYSTEM_GENERAL,
      generationConfig : { temperature: temp, topP: 0.8, maxOutputTokens: 4096 }
    });

    const userMsg = `다음 사업보고서를 분석하여 ${mode === 'expert' ? '전문가용 HTML' : '일반인용 JSON'} 리포트를 작성해주세요.

[회사명]: ${corpName}
[기준 사업연도]: ${year || '최근 사업연도'} (${term || ''})

[사업보고서 원문]:
${docText}`;

    const result = await model.generateContent(userMsg);
    let   output = result.response.text();

    // JSON 앞뒤 코드블록 제거
    if (mode === 'general') {
      output = output.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim();
    }

    // ── ④ 서버 캐시에 저장 (다음 사용자는 즉시 반환) ──
    saveToCache(cacheKey, output, { corpName, mode });

    console.log(`[/api/summarize] ✅ 완료: ${cacheKey}`);
    res.json({ mode, data: output, rcptNo, fromCache: false });

  } catch (err) {
    console.error('[/api/summarize] Gemini 오류:', err.message);
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
