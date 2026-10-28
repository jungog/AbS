/**
 * 静态资源托管 —— 让前端和 WebSocket 共用一个端口
 *
 * 为什么必须共用一个端口：
 * 客户端的 `resolveWsUrl()` 在生产环境里走的是**同源**（`location.host`），
 * 前端从 80/443 出来、WebSocket 就必须也在同一个 host:port 上。
 * 分成两个端口的话，浏览器要么跨域被拦，要么得给用户解释「还要再开一个端口」。
 *
 * 为什么自己写而不用 express / serve-static：
 * 这里只需要「把 dist 发出去」一件事。项目前端是零运行时依赖的，
 * 服务端为了发几个文件就背一个框架，属于用错误的方式换省事。
 *
 * 只做四件有实际意义的事：
 *  1. 带哈希的产物长缓存、index.html 不缓存（否则改版后用户永远拿到旧页面）
 *  2. 路径穿越防护（`%2e%2e%2f` 这类，解码后必须还在 root 里）
 *  3. ETag + 304（刷新页面时省掉重复传输）
 *  4. 无扩展名路径回落到 index.html（分享链接 `/?room=XXXX` 之外的前端路由也不会 404）
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Vite 产物带内容哈希（`index-BKqNkZZy.js`）。
 * 文件名一变 URL 就变，所以可以永久缓存 —— 这是首屏最快的做法。
 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

/** 统一的 JSON 响应（/healthz、/stats 用） */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<void>;

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = path.resolve(rootDir);
  const indexFile = path.join(root, 'index.html');

  return async function serveStatic(req, res, url) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('Method Not Allowed');
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // `%ZZ` 这种非法转义会让 decodeURIComponent 抛错
      plain(res, 400, 'Bad Request');
      return;
    }

    if (pathname.includes('\0')) {
      plain(res, 400, 'Bad Request');
      return;
    }

    // 第一道闸：解析成绝对路径后必须还在 root 之内。
    // 不要用「字符串里有没有 ..」来判断 —— Windows 上 `..\\`、`..%5c`、大小写混写都是变体。
    const target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      plain(res, 403, 'Forbidden');
      return;
    }

    let file = target;
    let info = await stat(file).catch(() => null);

    // 目录 → index.html
    if (info?.isDirectory()) {
      file = indexFile;
      info = await stat(file).catch(() => null);
    }

    // 无扩展名的路径 → 前端路由，回落 index.html。
    // 有扩展名却找不到的（比如 /assets/x.js）必须 404，
    // 否则浏览器会把一段 HTML 当 JS 执行，报错信息完全对不上问题。
    if (!info && path.extname(pathname) === '') {
      file = indexFile;
      info = await stat(file).catch(() => null);
    }

    if (!info || !info.isFile()) {
      plain(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(file).toLowerCase();
    const hashed = HASHED_NAME.test(path.basename(file));
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;

    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // 只有带内容哈希的文件能长缓存。index.html 一旦被缓存，
      // 改版后用户会一直拿到指向旧 chunk 的旧页面，直到手动强刷。
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
    if (method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(file);
    // 读一半出错（文件被删、磁盘故障）时直接断开连接，
    // 让浏览器看到的是「下载失败」而不是「一个静默截断的脚本」
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}
