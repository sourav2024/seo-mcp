import { getPage, pass, warn } from "./helpers.js";

/* ---------------- Caching / speed headers ---------------- */
export async function auditCaching(url, page) {
  const lines = ["## Caching & delivery headers"];
  const { body, headers } = await getPage(url, page);
  const cc = headers.get("cache-control");
  const enc = headers.get("content-encoding");
  const etag = headers.get("etag") || headers.get("last-modified");

  lines.push(
    cc
      ? pass(`Cache-Control: ${cc}`)
      : warn("No Cache-Control header — enable page/browser caching for a dramatic speed boost.")
  );
  lines.push(
    enc ? pass(`Compression enabled (${enc}).`) : warn("No content-encoding (gzip/br) detected — enable compression.")
  );
  lines.push(
    etag
      ? pass("ETag/Last-Modified present (revalidation supported).")
      : warn("No ETag/Last-Modified — revalidation not possible.")
  );

  const sizeKb = Math.round(Buffer.byteLength(body) / 1024);
  lines.push(
    sizeKb > 300
      ? warn(`HTML document is ${sizeKb} KB — consider minifying HTML/CSS/JS and trimming bloat.`)
      : pass(`HTML document size: ${sizeKb} KB.`)
  );
  return lines.join("\n");
}
