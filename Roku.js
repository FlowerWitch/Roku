#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), {
  boolean: ['h', 'help', 'pipe'],
  alias: { h: 'help' }
});

// 颜色代码
const COLOR = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  RESET: '\x1b[0m'
};

// 帮助信息
if (argv.h || argv.help) {
  console.log(`
OSS Hunter - 阿里云OSS桶探测工具

用法:
  node ${process.argv[1]} -u <url> [选项]
  node ${process.argv[1]} -l <file> [选项]

选项:
  -u <url>          单个目标URL
  -l <file>         从文件读取URL列表（每行一个）
  -L <level>        探测级别: 1=HTTP only, 2=Smart(默认), 3=Render only
  -X <method>       测试方法: PUT (测试桶是否可写)
  --pipe            管道模式: 只输出bucket URL到stdout（用于|传递给其他工具）
  
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
  
管道用法:
  node ${process.argv[1]} -l urls.txt --pipe | nuclei -t aliyun-oss.yaml
  node ${process.argv[1]} -u http://example.com --pipe | httpx -mc 200
`);
  process.exit(0);
}

const LEVEL = parseInt(argv.L || 2, 10);
const CONCURRENCY = 10;
const PIPE_MODE = argv.pipe;

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
  console.error('Usage: -u|-l [-L 1|2|3] [-X PUT] [--ob file] [--csv file] [--md file] [--oj file] [--pipe]');
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

/* ========== Playwright 渲染（带错误处理和复用） ========== */
let browser = null;
let browserLaunching = false;

async function getBrowser() {
  if (browser) return browser;
  if (browserLaunching) {
    while (browserLaunching) {
      await new Promise(r => setTimeout(r, 100));
    }
    return browser;
  }
  
  browserLaunching = true;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    if (!PIPE_MODE) {
      console.error(`${COLOR.YELLOW}[!] 浏览器启动失败: ${err.message}${COLOR.RESET}`);
    }
  }
  browserLaunching = false;
  return browser;
}

async function fetchRendered(url) {
  const found = new Set();
  
  try {
    const bw = await getBrowser();
    if (!bw) return [];
    
    const context = await bw.newContext();
    const page = await context.newPage();
    
    page.on('request', r => {
      const m = r.url().match(OSS_REGEX);
      if (m) m.forEach(x => found.add(x));
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    const html = await page.content();
    extractBuckets(html).forEach(x => found.add(x));
    
    await context.close();
  } catch (err) {
    if (!PIPE_MODE) {
      console.log(`    ${COLOR.YELLOW}[render error] ${err.message}${COLOR.RESET}`);
    }
  }
  
  return [...found];
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/* ========== 并发控制（带实时输出） ========== */
async function runWithRealtimeOutput(urls, worker) {
  const executing = new Set();
  
  for (const url of urls) {
    const promise = worker(url).then(() => {
      executing.delete(promise);
    }).catch(err => {
      if (!PIPE_MODE) {
        console.error(`[!] Error processing ${url}: ${err.message}`);
      }
      executing.delete(promise);
    });
    executing.add(promise);
    
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  
  await Promise.all(executing);
}

/* ========== 主逻辑 ========== */
(async () => {
  await runWithRealtimeOutput(urls, async (target) => {
    if (!PIPE_MODE) {
      console.log(`[*] ${target}`);
    }
    
    let buckets = [];

    if (LEVEL === 1) {
      buckets = extractBuckets(await fetchHTTP(target));
    }

    if (LEVEL === 2) {
      buckets = extractBuckets(await fetchHTTP(target));
      if (!buckets.length && !PIPE_MODE) {
        console.log('    [smart] fallback to render');
        buckets = await fetchRendered(target);
      } else if (!buckets.length) {
        buckets = await fetchRendered(target);
      }
    }

    if (LEVEL === 3) {
      buckets = await fetchRendered(target);
    }

    for (const b of buckets) {
      // 管道模式：直接输出 bucket URL，不添加任何其他内容
      if (PIPE_MODE) {
        console.log(b);
      } else {
        console.log(`    ${COLOR.GREEN}- ${b}${COLOR.RESET}`);
      }
      
      allBuckets.add(b);

      let putStatus = '';
      let putBool = false;
      if (argv.X === 'PUT' && !PIPE_MODE) {
        const putResult = await putTest(b);
        putStatus = putResult.success ? 'PUT_OK' : '';
        putBool = putResult.success;
        console.log(putResult.log);
      }

      records.push({ target, bucket: b, put: putStatus, putBool });
    }
  });

  // 关闭浏览器
  await closeBrowser();

  // 管道模式下不输出文件
  if (PIPE_MODE) {
    process.exit(0);
  }

  /* ========== 文件输出 ========== */
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
      const targetRecords = records.filter(r => r.target === target);
      if (targetRecords.length > 0) {
        jsonOutput[target] = targetRecords.map(r => ({
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