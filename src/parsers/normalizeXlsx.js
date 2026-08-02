// 학원에서 넘어오는 일부 엑셀 파일(특히 여러 시트가 있는 "통합성적표" 워크북)은
// 내부 stylesheet가 손상되어 있어 SheetJS/openpyxl 등 표준 파서로 바로 열면
// 시트가 비어있는 것처럼 보이는 문제가 실제로 2회 확인되었다.
// (openpyxl: "Stylesheet.from_tree" IndexError / SheetJS: Sheets={} 로 파싱됨)
//
// 해결책: LibreOffice headless로 한 번 재저장(xlsx→xlsx round-trip)하면
// stylesheet가 정리되어 정상적으로 열린다. 이 모듈은 그 정규화 단계를 감싼다.
//
// 운영 환경에는 LibreOffice(soffice)가 설치되어 있어야 한다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

function tryReadWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const hasContent = wb.SheetNames.length > 0 && Object.keys(wb.Sheets).length > 0;
  return { wb, hasContent };
}

/**
 * 엑셀 버퍼를 읽되, 손상된 stylesheet로 인해 빈 워크북이 나오면
 * LibreOffice headless 변환을 거쳐 재시도한다.
 * @param {Buffer} buffer
 * @param {{ sofficeBin?: string }} opts
 * @returns {XLSX.WorkBook}
 */
function readWorkbookRobust(buffer, opts = {}) {
  const { wb, hasContent } = tryReadWorkbook(buffer);
  if (hasContent) return wb;

  // 정규화 재시도
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-fix-'));
  const inPath = path.join(tmpDir, 'input.xlsx');
  fs.writeFileSync(inPath, buffer);
  try {
    execFileSync(opts.sofficeBin || 'soffice', [
      '--headless', '--convert-to', 'xlsx', '--outdir', tmpDir, inPath
    ], { stdio: 'pipe', env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp', HOME: tmpDir } });
    const fixedBuffer = fs.readFileSync(inPath); // soffice writes back to same name
    const retry = tryReadWorkbook(fixedBuffer);
    if (!retry.hasContent) {
      throw new Error('LibreOffice 정규화 후에도 시트를 읽을 수 없습니다 (파일 손상 가능성)');
    }
    return retry.wb;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { readWorkbookRobust };
