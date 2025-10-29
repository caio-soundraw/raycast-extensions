import { runAppleScript } from "@raycast/utils";
import * as fs from "fs";
import { getOrDownloadFile } from "./file";

/**
 * Playback state manager using singleton pattern
 */
class PlaybackStateManager {
  private static instance: PlaybackStateManager;
  private sampleId: string | null = null;
  private tempPath: string | undefined = undefined;
  private listeners = new Set<(sampleId: string | null) => void>();
  private playbackQueue: Promise<void> = Promise.resolve();

  static getInstance(): PlaybackStateManager {
    if (!PlaybackStateManager.instance) {
      PlaybackStateManager.instance = new PlaybackStateManager();
    }
    return PlaybackStateManager.instance;
  }

  subscribe(listener: (sampleId: string | null) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify with current state
    listener(this.sampleId);
    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener(this.sampleId));
  }

  getCurrentSampleId(): string | null {
    return this.sampleId;
  }

  getCurrentTempPath(): string | undefined {
    return this.tempPath;
  }

  setPlayingState(sampleId: string | null, tempPath?: string) {
    const wasPlaying = this.sampleId !== null;
    const previousSampleId = this.sampleId;
    const isNowPlaying = sampleId !== null;
    this.sampleId = sampleId;
    this.tempPath = tempPath;
    
    if (isNowPlaying) {
      console.debug(`[audio] playback state: playing sampleId=${sampleId}, tempPath=${tempPath}`);
    } else if (wasPlaying) {
      console.debug(`[audio] playback state: stopped (was playing sampleId=${previousSampleId})`);
    }
    
    this.notifyListeners();
  }

  // Serialize playback operations to prevent race conditions
  async enqueuePlayback<T>(operation: () => Promise<T>): Promise<T> {
    console.debug(`[audio] enqueueing playback operation`);
    const operationPromise = this.playbackQueue.then(() => {
      console.debug(`[audio] executing playback operation`);
      return operation();
    }).catch((error) => {
      console.debug(`[audio] playback operation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      // Ignore errors in queue chain
      return undefined as unknown as T;
    });
    this.playbackQueue = operationPromise.then(() => {
      console.debug(`[audio] playback operation completed`);
      return undefined;
    });
    return operationPromise;
  }

  cleanup() {
    if (this.tempPath) {
      console.debug(`[audio] cleaning up temp file: ${this.tempPath}`);
      try {
        if (fs.existsSync(this.tempPath)) {
          fs.unlinkSync(this.tempPath);
          console.debug(`[audio] temp file deleted: ${this.tempPath}`);
        } else {
          console.debug(`[audio] temp file does not exist: ${this.tempPath}`);
        }
      } catch (error) {
        console.debug(`[audio] failed to delete temp file: ${this.tempPath} - ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      this.tempPath = undefined;
    }
    if (this.sampleId) {
      console.debug(`[audio] cleanup: clearing sampleId=${this.sampleId}`);
    }
    this.sampleId = null;
    this.notifyListeners();
  }

  // Cleanup all resources when command unmounts
  destroy() {
    console.debug(`[audio] destroying playback manager (${this.listeners.size} listeners)`);
    this.cleanup();
    this.listeners.clear();
  }
}

/**
 * Play audio file using QuickTime Player
 * @param audioUrl The URL of the audio file
 * @param sampleId The sample ID for state tracking
 * @param sampleName The sample name for creating the temp file
 * @returns Promise that resolves when playback starts
 */
export async function playAudio(audioUrl: string, sampleId: string, sampleName: string): Promise<void> {
  const manager = PlaybackStateManager.getInstance();
  
  console.debug(`[audio] playAudio requested: sampleId=${sampleId}, url=${audioUrl}, name=${sampleName}`);
  
  await manager.enqueuePlayback(async () => {
    // Stop any currently playing audio first
    const currentPlaying = manager.getCurrentSampleId();
    if (currentPlaying) {
      console.debug(`[audio] stopping current playback (sampleId=${currentPlaying}) before starting new one`);
    }
    await stopAudio();

    try {
      console.debug(`[audio] getting/downloading file for playback: ${audioUrl}`);
      // Get or download the file (uses cache if available, with sanitized filename)
      const { path: filePath } = await getOrDownloadFile(audioUrl, "/tmp", sampleName);
      console.debug(`[audio] file ready for playback: ${filePath}`);

      // Update state
      manager.setPlayingState(sampleId, filePath);

      // Sanitize path for AppleScript (escape special characters)
      const sanitizedPath = filePath.replace(/"/g, '\\"');

      console.debug(`[audio] launching QuickTime Player with file: ${filePath}`);
      // Use AppleScript to play the audio file in QuickTime Player
      const appleScript = `tell application "QuickTime Player"
        activate
        open POSIX file "${sanitizedPath}"
        set theMovie to front document
        set looping of theMovie to true
        play theMovie
      end tell`;

      await runAppleScript(appleScript);
      console.debug(`[audio] playback started successfully: sampleId=${sampleId}`);
    } catch (error) {
      console.debug(`[audio] playback failed: sampleId=${sampleId} - ${error instanceof Error ? error.message : "Unknown error"}`);
      // Update global state to stop playing
      manager.cleanup();
      throw error;
    }
  });
}

/**
 * Stop audio playback
 */
export async function stopAudio(): Promise<void> {
  const manager = PlaybackStateManager.getInstance();
  const currentSampleId = manager.getCurrentSampleId();
  
  if (currentSampleId) {
    console.debug(`[audio] stopAudio requested: sampleId=${currentSampleId}`);
  } else {
    console.debug(`[audio] stopAudio requested: no audio currently playing`);
    return;
  }
  
  try {
    console.debug(`[audio] sending stop command to QuickTime Player`);
    // Use AppleScript to stop QuickTime Player
    const stopScript = `tell application "QuickTime Player"
      if (count of documents) > 0 then
        close front document
      end if
    end tell`;

    await runAppleScript(stopScript);
    console.debug(`[audio] QuickTime Player stopped successfully`);
  } catch (error) {
    console.debug(`[audio] failed to stop QuickTime Player: ${error instanceof Error ? error.message : "Unknown error"}`);
    // Continue cleanup even if stop fails
  } finally {
    // Clean up temp file and state
    manager.cleanup();
    console.debug(`[audio] stopAudio completed: sampleId=${currentSampleId}`);
  }
}

/**
 * Check if a sample is currently playing
 * @param sampleId The sample ID to check
 * @returns True if the sample is playing
 */
export function isPlaying(sampleId: string): boolean {
  const manager = PlaybackStateManager.getInstance();
  return manager.getCurrentSampleId() === sampleId;
}

// Export the manager for direct access if needed
export const getPlaybackManager = () => PlaybackStateManager.getInstance();

/**
 * Cleanup all playback resources (call on component unmount)
 */
export function cleanupPlayback(): void {
  console.debug(`[audio] cleanupPlayback called`);
  const manager = PlaybackStateManager.getInstance();
  manager.destroy();
}
