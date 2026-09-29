/**
 * GS1 barcode parser — สำเนาของ GS1Parser.gs ใน Apps Script (ถ้าแก้ ให้แก้ทั้ง 2 ไฟล์ให้ตรงกัน)
 *
 * รองรับ:
 *  1) GS1 DataMatrix/QR แบบดิบจากเครื่องสแกน/กล้อง (มีตัวคั่น GS = ASCII 29)
 *  2) แบบดิบที่เครื่องสแกนไม่ส่งตัวคั่น GS (Lot ติดกับ REF) — แยกให้ด้วย 3 วิธี:
 *       ก. รูปแบบท้ายบาร์โค้ดที่ระบบจำไว้ของสินค้านั้น (opts.tails: { GTIN: 'ส่วนท้าย' | 'NONE' })  -> แม่นยำ
 *       ข. Lot ที่เคยรับเข้าแล้ว (ทำในหน้าเว็บ)                                                   -> แม่นยำ
 *       ค. เดาจากโครงสร้าง AI (ขึ้นคำเตือนให้ตรวจ Lot)                                           -> ครั้งแรกเท่านั้น
 *  3) แบบมีวงเล็บที่พิมพ์ใต้บาร์โค้ด เช่น "(01)00380740130084(17)270131(10)50651Y600"
 *  4) บาร์โค้ด 1D ธรรมดา (EAN-13/UPC/GTIN-14) -> ได้แค่ GTIN
 *
 * AI ที่พบบ่อยบนกล่องน้ำยา: 01 GTIN · 17 วันหมดอายุ · 10 Lot · 11 วันผลิต · 21 Serial · 240 REF/Catalog no.
 */

const GS = String.fromCharCode(29);

// AI ความยาวคงที่ (ไม่ต้องมีตัวคั่น)
const GS1_FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
// AI ความยาวแปรผัน (จบด้วย GS หรือจบข้อความ) : ความยาวสูงสุด
const GS1_VAR = { '240': 30, '241': 30, '250': 30, '251': 30, '400': 30,
                  '10': 20, '21': 20, '22': 20, '30': 8, '37': 8,
                  '90': 30, '91': 90, '92': 90, '93': 90, '94': 90, '95': 90, '96': 90, '97': 90, '98': 90, '99': 90 };
const GS1_NAME = { '01': 'gtin', '10': 'lot', '17': 'exp', '11': 'mfgDate', '21': 'serial', '240': 'ref', '30': 'count' };
// AI วันที่ที่อาจตามหลังค่าความยาวแปรผันได้เมื่อไม่มีตัวคั่น
const GS1_DATE_AIS = ['11', '12', '13', '15', '16', '17'];
const GS1_GUESS_MSG = 'เครื่องสแกนไม่ส่งตัวคั่น — ระบบแยก Lot ให้โดยประมาณ กรุณาตรวจ Lot ก่อนเพิ่ม (ยืนยันครั้งเดียว ครั้งต่อไปจะแยกให้อัตโนมัติ)';

function parseGS1(input, opts) {
  opts = opts || {};
  let raw = String(input == null ? '' : input).trim();
  const out = { raw: raw, ais: {}, gtin: '', lot: '', exp: '', ref: '', serial: '', type: '', warnings: [],
                noGS: false, lotRaw: '', lotGuess: false };
  if (!raw) { out.warnings.push('ไม่มีข้อมูล'); return out; }

  // ตัด symbology identifier ที่เครื่องสแกนบางรุ่นเติมหน้า เช่น ]d2 ]Q3 ]C1 ]e0
  raw = raw.replace(/^\][A-Za-z]\d/, '');
  if (raw.charAt(0) === GS) raw = raw.slice(1); // FNC1 นำหน้า

  if (/^\(\d{2,4}\)/.test(raw)) {
    // แบบมีวงเล็บ
    out.type = 'GS1 (HRI)';
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(raw))) out.ais[m[1]] = m[2].replace(new RegExp(GS, 'g'), '').trim();
  } else if (/^\d{8,14}$/.test(raw)) {
    // บาร์โค้ด 1D
    out.type = 'EAN/UPC';
    out.ais['01'] = raw.padStart(14, '0');
  } else if (/^\d{2}/.test(raw) && (GS1_FIXED[raw.slice(0, 2)] || GS1_VAR[raw.slice(0, 2)] || GS1_VAR[raw.slice(0, 3)])) {
    // แบบดิบ
    out.type = 'GS1';
    out.noGS = raw.indexOf(GS) < 0;
    let i = 0;
    while (i < raw.length) {
      if (raw.charAt(i) === GS) { i++; continue; }
      const a2 = raw.substr(i, 2), a3 = raw.substr(i, 3);
      if (GS1_FIXED[a2]) {
        out.ais[a2] = raw.substr(i + 2, GS1_FIXED[a2]);
        i += 2 + GS1_FIXED[a2];
        continue;
      }
      const ai = GS1_VAR[a3] ? a3 : GS1_VAR[a2] ? a2 : null;
      if (!ai) { out.warnings.push('ไม่รู้จัก AI ที่ตำแหน่ง ' + i + ': ' + raw.slice(i)); break; }
      const start = i + ai.length, end = raw.indexOf(GS, start);
      if (end >= 0) { out.ais[ai] = raw.slice(start, end); i = end; continue; }
      // ไม่มีตัวคั่นจนจบข้อความ: ค่านี้อาจมี AI อื่นต่อท้ายอยู่ (เช่น Lot ติดกับ REF)
      const res = gs1Resolve_(raw.slice(i), ai, out, opts);
      Object.keys(res).forEach(k => { if (!(k in out.ais)) out.ais[k] = res[k]; });
      break;
    }
  } else {
    out.type = 'Unknown';
    out.warnings.push('ไม่ใช่รูปแบบ GS1 — บันทึกเป็นรหัสดิบ');
    return out;
  }

  Object.keys(out.ais).forEach(ai => { if (GS1_NAME[ai]) out[GS1_NAME[ai]] = out.ais[ai]; });
  if (out.exp) out.exp = gs1Date_(out.exp);
  if (out.mfgDate) out.mfgDate = gs1Date_(out.mfgDate);
  if (out.gtin && !gtinValid_(out.gtin)) out.warnings.push('GTIN check digit ไม่ถูกต้อง');
  return out;
}

/** แยกข้อความส่วนท้ายที่ไม่มีตัวคั่น rest = AI + ค่า (+ AI อื่นที่ติดกันมา) */
function gs1Resolve_(rest, ai, out, opts) {
  const val = rest.slice(ai.length);
  if (ai === '10') out.lotRaw = val;

  // ก. รูปแบบท้ายที่เคยยืนยันแล้วของ GTIN นี้
  const tail = ai === '10' && opts.tails && out.ais['01'] ? opts.tails[out.ais['01']] : '';
  if (tail === 'NONE') return { '10': val };
  if (tail && val.length > tail.length && val.slice(-tail.length) === tail) {
    const res = { '10': val.slice(0, -tail.length) };
    const tp = gs1Best_(tail);
    if (tp) tp.parse.forEach(p => { if (!(p[0] in res)) res[p[0]] = p[1]; });
    return res;
  }

  // ค. เดาจากโครงสร้าง
  const best = gs1Best_(rest);
  if (!best) {
    out.warnings.push('แยกข้อมูลจากบาร์โค้ดไม่ได้ — ตรวจสอบข้อมูลด้วยตา');
    const r = {}; r[ai] = val; return r;
  }
  const res = {};
  best.parse.forEach(p => { if (!(p[0] in res)) res[p[0]] = p[1]; });
  if (best.count > 1) {
    if (ai === '10') out.lotGuess = true;
    out.warnings.push(GS1_GUESS_MSG);
  }
  return res;
}

/** ทางเลือกการแยกที่ดีที่สุด: ได้ AI มากสุด โดยหักคะแนนค่าที่สั้นผิดปกติ (< 4 ตัว) */
function gs1Best_(s) {
  const all = gs1Split_(s);
  if (!all.length) return null;
  const score = p => p.length - 1.5 * p.filter(x => GS1_VAR[x[0]] && x[1].length < 4).length;
  let best = all[0];
  all.forEach(p => { if (score(p) > score(best)) best = p; });
  return { parse: best, count: all.length };
}

/** ทุกวิธีที่แยกข้อความ (ไม่มีตัวคั่น) ออกเป็น AI ได้ครบพอดี */
function gs1Split_(s) {
  const out = [];
  const isStart = k => !!(GS1_VAR[s.substr(k, 3)] || GS1_VAR[s.substr(k, 2)] || GS1_DATE_AIS.indexOf(s.substr(k, 2)) >= 0);
  const go = (i, acc) => {
    if (out.length >= 300) return;
    if (i === s.length) { out.push(acc); return; }
    const a2 = s.substr(i, 2), a3 = s.substr(i, 3);
    if (GS1_FIXED[a2]) {
      const v = s.substr(i + 2, GS1_FIXED[a2]);
      if (v.length !== GS1_FIXED[a2] || !/^\d+$/.test(v)) return;
      if (GS1_DATE_AIS.indexOf(a2) >= 0 && !/^\d\d(0[1-9]|1[0-2])(0\d|[12]\d|3[01])$/.test(v)) return;
      go(i + 2 + v.length, acc.concat([[a2, v]]));
      return;
    }
    const ai = GS1_VAR[a3] ? a3 : GS1_VAR[a2] ? a2 : null;
    if (!ai) return;
    const st = i + ai.length, max = Math.min(s.length, st + GS1_VAR[ai]);
    for (let k = st + 1; k <= max; k++) {
      if (k < s.length && !isStart(k)) continue;
      const v = s.slice(st, k);
      if ((ai === '30' || ai === '37') && !/^\d+$/.test(v)) continue;
      go(k, acc.concat([[ai, v]]));
    }
  };
  go(0, []);
  return out;
}

// YYMMDD -> yyyy-mm-dd (DD = 00 หมายถึงวันสุดท้ายของเดือน)
function gs1Date_(s) {
  if (!/^\d{6}$/.test(s)) return s;
  const y = 2000 + Number(s.slice(0, 2)), m = Number(s.slice(2, 4));
  let d = Number(s.slice(4, 6));
  if (d === 0) d = new Date(y, m, 0).getDate();
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function gtinValid_(g) {
  if (!/^\d{14}$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[13]);
}
