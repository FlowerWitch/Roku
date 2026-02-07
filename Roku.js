#!/usr/bin/env node
// npm install axios minimist playwright
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), {
  boolean: ['h', 'help'],
  alias: { h: 'help' }
});

// 颜色代码
const COLOR = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  RESET: '\x1b[0m'
};

// 帮助信息
if (argv.h || argv.help) {
  console.log(`
  ❀Ali OSS Scan❀

用法:
  node ${process.argv[1]} -u <url> [选项]
  node ${process.argv[1]} -l <file> [选项]

选项:
  -u <url>          单个目标URL
  -l <file>         从文件读取URL列表（每行一个）
  -L <level>        探测级别: 1=HTTP only, 2=Smart(默认), 3=Render only
  -X <method>       测试方法: PUT (测试桶是否可写)
  
输出选项:
  --ob <file>       输出bucket列表（纯文本）
  --csv <file>      输出CSV格式
  --md <file>       输出Markdown表格
  --oj <file>       输出JSON格式
  
其他:
  -h, --help        显示此帮助信息

依赖安装:
  npm install axios minimist playwright

示例:
  node ${process.argv[1]} -u http://example.com -L 2
  node ${process.argv[1]} -l urls.txt --ob buckets.txt
  node ${process.argv[1]} -l urls.txt -X PUT --oj result.json
`);
  process.exit(0);
}

const LEVEL = parseInt(argv.L || 2, 10);
const CONCURRENCY = 10;

const urls = [];
if (argv.u) urls.push(argv.u);
if (argv.l) {
  try {
    fs.readFileSync(argv.l, 'utf8')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean)
      .forEach(x => urls.push(x));
  } catch (err) {
    console.error(`[!] 无法读取文件: ${argv.l}`);
    process.exit(1);
  }
}
if (!urls.length) {
  console.error('Usage: -u|-l [-L 1|2|3] [-X PUT] [--ob file] [--csv file] [--md file] [--oj file]');
  console.error('Use -h or --help for more information');
  process.exit(1);
}

const OSS_REGEX = /https?:\/\/[a-zA-Z0-9.-]+\.oss-[a-z0-9-]+\.aliyuncs\.com/g;

const allBuckets = new Set();
const records = [];

/* ========== utils ========== */
function randHex(n = 16) {
  return crypto.randomBytes(n / 2).toString('hex');
}

async function fetchHTTP(url) {
  try {
    const res = await axios.get(url, {
      timeout: 6000,
      validateStatus: () => true
    });
    return res.data || '';
  } catch {
    return '';
  }
}

function extractBuckets(text) {
  return [...new Set(text.match(OSS_REGEX) || [])];
}

/* ========== PUT test ========== */
async function putTest(bucket) {
  const name = `${randHex()}.ppa`;
  const url = `${bucket.replace(/\/$/, '')}/${name}`;
  try {
    const res = await axios.put(url, randHex(32), {
      timeout: 6000,
      headers: { 'Content-Type': 'application/octet-stream' },
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300) {
      return { 
        success: true, 
        log: `        ${COLOR.RED}[PUT OK]${COLOR.RESET} ${url}` 
      };
    }
  } catch {}
  return { 
    success: false, 
    log: `        [PUT FAIL] ${bucket}` 
  };
}

/* ========== Playwright 渲染 ========== */
async function fetchRendered(url) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const found = new Set();

  page.on('request', r => {
    const m = r.url().match(OSS_REGEX);
    if (m) m.forEach(x => found.add(x));
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    const html = await page.content();
    extractBuckets(html).forEach(x => found.add(x));
  } catch {}

  await browser.close();
  return [...found];
}

/* ========== 并发池 ========== */
async function runPool(items, worker) {
  let i = 0;
  const pool = Array(CONCURRENCY).fill(0).map(async () => {
    while (i < items.length) {
      const cur = items[i++];
      await worker(cur);
    }
  });
  await Promise.all(pool);
}

/* ========== 主逻辑 ========== */
(async () => {
  const urlResults = new Map();

  await runPool(urls, async (target) => {
    const logs = [];
    const localRecords = [];
    let buckets = [];

    if (LEVEL === 1) {
      buckets = extractBuckets(await fetchHTTP(target));
    }

    if (LEVEL === 2) {
      buckets = extractBuckets(await fetchHTTP(target));
      if (!buckets.length) {
        logs.push('    [smart] fallback to render');
        buckets = await fetchRendered(target);
      }
    }

    if (LEVEL === 3) {
      buckets = await fetchRendered(target);
    }

    for (const b of buckets) {
      // Bucket 绿色
      logs.push(`    ${COLOR.GREEN}- ${b}${COLOR.RESET}`);
      allBuckets.add(b);

      let putStatus = '';
      let putBool = false;
      if (argv.X === 'PUT') {
        const putResult = await putTest(b);
        putStatus = putResult.success ? 'PUT_OK' : '';
        putBool = putResult.success;
        logs.push(putResult.log);
      }

      localRecords.push({ target, bucket: b, put: putStatus, putBool });
    }

    urlResults.set(target, { logs, records: localRecords });
  });

  for (const target of urls) {
    const result = urlResults.get(target);
    if (result) {
      console.log(`[*] ${target}`);
      if (result.logs.length) {
        console.log(result.logs.join('\n'));
      }
      result.records.forEach(r => records.push(r));
    }
  }

  /* ========== 输出 ========== */
  if (argv.ob) {
    fs.writeFileSync(argv.ob, [...allBuckets].join('\n'));
    console.log(`\n[+] Exported ${allBuckets.size} buckets to ${argv.ob}`);
  }

  if (argv.csv) {
    fs.writeFileSync(
      argv.csv,
      ['target,bucket,put_status', ...records.map(r => `${r.target},${r.bucket},${r.put}`)].join('\n')
    );
    console.log(`[+] Exported CSV to ${argv.csv}`);
  }

  if (argv.md) {
    fs.writeFileSync(
      argv.md,
      [
        '| Target | Bucket | PUT |',
        '|------|------|------|',
        ...records.map(r => `| ${r.target} | ${r.bucket} | ${r.put ? '✅' : ''} |`)
      ].join('\n')
    );
    console.log(`[+] Exported Markdown to ${argv.md}`);
  }

  if (argv.oj) {
    const jsonOutput = {};
    for (const target of urls) {
      const result = urlResults.get(target);
      if (result && result.records.length > 0) {
        jsonOutput[target] = result.records.map(r => ({
          bucket: r.bucket,
          put: r.putBool
        }));
      } else {
        jsonOutput[target] = [];
      }
    }
    fs.writeFileSync(argv.oj, JSON.stringify(jsonOutput, null, 2));
    console.log(`[+] Exported JSON to ${argv.oj}`);
  }
})();