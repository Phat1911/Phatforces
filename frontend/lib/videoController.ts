/**
 * VideoController - global singleton that owns ALL video playback.
 *
 * KEY DESIGN: VideoCards register their <video> element via a CALLBACK REF
 * (not useEffect). Callback refs fire synchronously when the DOM node is
 * inserted, which guarantees the element is in the map before any
 * IntersectionObserver callback can call activate() for that element.
 *
 * Flow:
 *   1. React renders VideoCard → DOM insert → callbackRef fires → register()
 *   2. Browser detects intersection → queues IO callback (async, next task)
 *   3. IO callback runs → activate(id) → element IS in map → stop old, play new
 *
 * Usage:
 *   VideoCard: <video ref={videoController.refCallback(video.id)} ... />
 *   page.tsx IntersectionObserver: videoController.activate(videoId)
 *   Mute button: videoController.toggleMute()
 */

class VideoController {
  private videos = new Map<string, HTMLVideoElement>();
  private activeId: string | null = null;
  /** true = muted. Starts true (browser autoplay policy requires muted for autoplay). */
  public globalMuted = true;

  /**
   * Returns a stable callback ref for a given videoId.
   * Use as: <video ref={videoController.refCallback(video.id)} />
   * This fires synchronously on DOM insert/remove - no useEffect needed.
   */
  refCallback(id: string) {
    return (el: HTMLVideoElement | null) => {
      if (el) {
        this.videos.set(id, el);
      } else {
        // el is null on unmount
        if (this.activeId === id) {
          const prev = this.videos.get(id);
          if (prev) { prev.muted = true; prev.pause(); }
          this.activeId = null;
        }
        this.videos.delete(id);
      }
    };
  }

  /**
   * Make `id` the active video.
   * Stops the previous video SYNCHRONOUSLY, then plays the new one.
   * Called from IntersectionObserver callback - zero React cycle involved.
   */
  activate(id: string) {
    if (this.activeId === id) return;

    // Stop current immediately - synchronous DOM call, no async gap
    if (this.activeId) {
      const prev = this.videos.get(this.activeId);
      if (prev) {
        prev.muted = true;
        prev.pause();
        prev.currentTime = 0;
      }
    }

    this.activeId = id;
    const next = this.videos.get(id);
    if (!next) return;

    next.muted = this.globalMuted;
    next.currentTime = 0;
    next.play()?.catch(() => {
      // Browser blocked unmuted autoplay - fall back to muted and retry
      next.muted = true;
      this.globalMuted = true;
      next.play()?.catch(() => {});
    });
  }

  stopAll() {
    this.videos.forEach((el) => { el.muted = true; el.pause(); });
    this.activeId = null;
  }

  toggleMute(): boolean {
    this.globalMuted = !this.globalMuted;
    if (this.activeId) {
      const el = this.videos.get(this.activeId);
      if (el) el.muted = this.globalMuted;
    }
    return this.globalMuted;
  }

  isMuted(): boolean { return this.globalMuted; }

  getActiveId(): string | null { return this.activeId; }

  togglePlayPause(id: string): boolean {
    const el = this.videos.get(id);
    if (!el) return false;
    if (el.paused) { el.play().catch(() => {}); return false; }
    else { el.pause(); return true; }
  }
}

export const videoController = new VideoController();
