import * as fs from "fs";
import { execSync } from "child_process";
import { downloadAndCache } from "./cache";
import { log } from "./log";

/**
 * Get file extension from Content-Type header or URL
 */
export function getFileExtension(contentType: string | null, url: string): string {
  if (contentType) {
    const mimeTypeMap: Record<string, string> = {
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/wav": "wav",
      "audio/webm": "webm",
      "audio/ogg": "ogg",
    };
    const extension = mimeTypeMap[contentType.toLowerCase()];
    if (extension) return extension;
  }

  // Fallback: extract from URL
  const urlMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  // Default fallback
  return "m4a";
}

/**
 * Sanitize filename - handle spaces and special characters
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\s-]/g, "_").replace(/\s+/g, "_");
}

/**
 * Save file to /tmp directory with sanitized filename
 * Reuses existing temp file if it already exists (from Play action, for example)
 * @param url The source URL
 * @param fileName The desired file name (without extension)
 * @param buffer The file data buffer
 * @param contentType Optional content type to determine extension
 * @param tempDir Optional temp directory (defaults to /tmp)
 * @returns The full path to the saved file
 */
export function saveToDownloads(
  url: string,
  fileName: string,
  buffer: Buffer,
  contentType: string | null = null,
  tempDir: string = "/tmp",
): string {
  const sanitizedName = sanitizeFileName(fileName);
  const extension = getFileExtension(contentType, url);
  const filename = `${sanitizedName}.${extension}`;
  const filePath = `${tempDir}/${filename}`;

  log.debug(`[file] saving to temp directory: ${filename} (${buffer.length} bytes) at ${filePath}`);

  // Write file with error recovery
  try {
    // If file already exists, we can reuse it
    if (fs.existsSync(filePath)) {
      log.debug(`[file] file already exists, reusing: ${filename} at ${filePath}`);
      return filePath;
    }

    // Write file and ensure it's fully synced to disk
    const fd = fs.openSync(filePath, "w");
    try {
      fs.writeSync(fd, buffer);
      fs.fsyncSync(fd); // Force write to disk
    } finally {
      fs.closeSync(fd);
    }
    log.debug(`[file] saved successfully: ${filename} at ${filePath}`);
  } catch (writeError) {
    log.debug(
      `[file] failed to save: ${filename} - ${writeError instanceof Error ? writeError.message : "Unknown error"}`,
    );
    // Clean up partial file if it exists
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to write file: ${writeError instanceof Error ? writeError.message : "Unknown error"}`);
  }

  return filePath;
}

/**
 * Copy file reference to clipboard using AppleScript
 * @param filePath The file path to copy
 */
export function copyFileToClipboard(filePath: string): void {
  // Sanitize path for AppleScript (escape special characters)
  const sanitizedPath = filePath.replace(/"/g, '\\"');

  try {
    execSync(`osascript -e 'set the clipboard to (POSIX file "${sanitizedPath}")'`);
  } catch {
    // File was written successfully even if clipboard fails
    // We can optionally throw here if clipboard is critical
  }
}

/**
 * Write buffer to temporary file
 * @param buffer The data buffer to write
 * @param url The source URL (for determining file extension)
 * @param contentType Optional content type (for determining file extension)
 * @param tempDir Optional temp directory (defaults to /tmp)
 * @param customFileName Optional custom filename (without extension). If not provided, uses timestamp.
 * @returns The path to the temporary file
 */
export function writeTempFile(
  buffer: Buffer,
  url: string,
  contentType: string | null = null,
  tempDir: string = "/tmp",
  customFileName?: string,
): string {
  const extension = getFileExtension(contentType, url);
  const tempFileName = customFileName ? `${customFileName}.${extension}` : `soundraw_${Date.now()}.${extension}`;
  const tempFilePath = `${tempDir}/${tempFileName}`;

  // Check if file already exists (from previous Play action, for example)
  if (fs.existsSync(tempFilePath)) {
    log.debug(`[file] temp file already exists, reusing: ${tempFileName} at ${tempFilePath}`);
    return tempFilePath;
  }

  log.debug(`[file] writing temp file: ${tempFileName} (${buffer.length} bytes) at ${tempFilePath}`);

  // Write file and ensure it's fully synced to disk to prevent race conditions
  const fd = fs.openSync(tempFilePath, "w");
  try {
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd); // Force write to disk
  } finally {
    fs.closeSync(fd);
  }

  log.debug(`[file] temp file created and synced: ${tempFileName} at ${tempFilePath}`);

  return tempFilePath;
}

/**
 * Get or download file and create temp file for playback
 * Uses cache if available, downloads and caches if not
 * @param url The URL to get
 * @param tempDir Optional temp directory (defaults to /tmp)
 * @param customFileName Optional custom filename (without extension). If provided, uses sanitized version.
 * @returns The local file path and content type
 */
export async function getOrDownloadFile(
  url: string,
  tempDir: string = "/tmp",
  customFileName?: string,
): Promise<{ path: string; contentType: string | null }> {
  log.debug(`[file] getOrDownloadFile: ${url} (tempDir: ${tempDir}, customFileName: ${customFileName || "none"})`);

  // Download and cache (uses cache if available)
  const { buffer, contentType } = await downloadAndCache(url);

  log.debug(`[file] got buffer: ${buffer.length} bytes (contentType: ${contentType || "unknown"})`);

  // Sanitize custom filename if provided
  const sanitizedFileName = customFileName ? sanitizeFileName(customFileName) : undefined;

  const tempFilePath = writeTempFile(buffer, url, contentType, tempDir, sanitizedFileName);

  return { path: tempFilePath, contentType };
}

/**
 * Get the expected file path for a sample (without downloading)
 * This is useful for drag and drop - the file should already exist in /tmp
 * @param url The sample URL
 * @param sampleName The sample name
 * @param tempDir Optional temp directory (defaults to /tmp)
 * @returns The expected file path
 */
export function getExpectedFilePath(
  url: string,
  sampleName: string,
  contentType: string | null = null,
  tempDir: string = "/tmp",
): string {
  const sanitizedName = sanitizeFileName(sampleName);
  const extension = getFileExtension(contentType, url);
  const filename = `${sanitizedName}.${extension}`;
  return `${tempDir}/${filename}`;
}

/**
 * Remove temp files created by this extension that are older than maxAgeMs
 * Only targets files starting with the "soundraw_" prefix and common audio extensions
 * This is safe because our `writeTempFile` uses that prefix by default.
 */
export function cleanupOldTempFiles(tempDir: string = "/tmp", maxAgeMs: number = 4 * 60 * 60 * 1000): void {
  try {
    const now = Date.now();
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });

    const audioExtensions = new Set(["mp3", "m4a", "wav", "webm", "ogg", "aac", "flac"]);

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;

      // Match files created by this extension via writeTempFile("soundraw_...")
      if (!name.startsWith("soundraw_")) continue;

      const dotIndex = name.lastIndexOf(".");
      const ext = dotIndex > -1 ? name.slice(dotIndex + 1).toLowerCase() : "";
      if (!audioExtensions.has(ext)) continue;

      const filePath = `${tempDir}/${name}`;
      try {
        const stats = fs.statSync(filePath);
        const ageMs = now - stats.mtimeMs;
        if (ageMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          log.debug(`[file] cleaned old temp file: ${filePath}`);
        }
      } catch {
        // Ignore per-file errors
      }
    }
  } catch {
    // Ignore cleanup errors overall
  }
}
