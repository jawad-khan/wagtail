import { Controller } from '@hotwired/stimulus';

/**
 * Fetches images from user-provided URLs entirely on the client side
 * (via the Fetch API) and dispatches events so that the fetched files
 * can be handed off to the existing upload pipeline.
 *
 * Supports a `<textarea>` with one URL per line (batch import on the
 * multi-add page) as well as a single `<input type="url">` (chooser).
 *
 * When a `fileSelector` value is set the fetched file is assigned to
 * the matching input element (chooser mode).  Otherwise a
 * `w-url-import:add` event is dispatched per file so that external
 * code (e.g. the jQuery File Upload bridge) can handle it.
 *
 * @example - Batch import on the multiple-image-add page
 * ```html
 * <div
 *   data-controller="w-url-import"
 *   data-w-url-import-max-size-value="10485760"
 *   data-w-url-import-accept-value="jpg,png,gif,webp,avif"
 * >
 *   <textarea data-w-url-import-target="input" rows="3"></textarea>
 *   <button
 *     type="button"
 *     data-action="click->w-url-import#performImport"
 *     data-w-url-import-target="submit"
 *   >Import</button>
 *   <div data-w-url-import-target="errors" hidden></div>
 * </div>
 * ```
 *
 * @example - Single-URL import inside the image chooser
 * ```html
 * <div
 *   data-controller="w-url-import"
 *   data-w-url-import-max-size-value="10485760"
 *   data-w-url-import-accept-value="jpg,png,gif,webp,avif"
 *   data-w-url-import-file-selector-value="#id_image-chooser-upload-file"
 * >
 *   <input type="url" data-w-url-import-target="input" />
 *   <button
 *     type="button"
 *     data-action="click->w-url-import#performImport"
 *     data-w-url-import-target="submit"
 *   >Import</button>
 *   <div data-w-url-import-target="errors" hidden></div>
 * </div>
 * ```
 */
export class UrlImportController extends Controller {
  static targets = ['input', 'errors', 'submit'];

  static values = {
    accept: { type: String, default: '' },
    maxSize: { type: Number, default: 0 },
    concurrency: { type: Number, default: 3 },
    fileSelector: { type: String, default: '' },
  };

  declare readonly inputTarget: HTMLTextAreaElement | HTMLInputElement;
  declare readonly errorsTarget: HTMLElement;
  declare readonly submitTarget: HTMLButtonElement;

  declare acceptValue: string;
  declare maxSizeValue: number;
  declare concurrencyValue: number;
  declare fileSelectorValue: string;

  /**
   * Main action: parse URLs from the input, fetch them in parallel
   * (bounded by concurrency), and hand off each result.
   */
  async performImport(event?: Event) {
    event?.preventDefault();

    const urls = this.parseUrls();
    if (urls.length === 0) return;

    this.clearErrors();
    this.setLoading(true);

    const results = await this.fetchAll(urls);

    const failedUrls: string[] = [];
    const errors: string[] = [];

    results.forEach(({ url, file, error }) => {
      if (file) {
        this.deliverFile(file);
      } else {
        failedUrls.push(url);
        errors.push(`${url} — ${error}`);
      }
    });

    if (errors.length > 0) {
      this.showErrors(errors);
    }

    // Clear input on full success; keep failed URLs for retry.
    if (failedUrls.length === 0) {
      this.inputTarget.value = '';
    } else {
      this.inputTarget.value = failedUrls.join('\n');
    }

    this.setLoading(false);
  }

  // ---- URL parsing ---------------------------------------------------

  private parseUrls(): string[] {
    const raw = this.inputTarget.value.trim();
    if (!raw) return [];

    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // ---- Concurrent fetching -------------------------------------------

  private async fetchAll(
    urls: string[],
  ): Promise<{ url: string; file?: File; error?: string }[]> {
    const limit = Math.max(1, this.concurrencyValue);
    const results: { url: string; file?: File; error?: string }[] = [];
    let index = 0;

    const next = async (): Promise<void> => {
      while (index < urls.length) {
        const currentIndex = index++;
        const url = urls[currentIndex];
        results[currentIndex] = await this.fetchImage(url);
      }
    };

    const workers = Array.from({ length: Math.min(limit, urls.length) }, () =>
      next(),
    );
    await Promise.all(workers);
    return results;
  }

  private async fetchImage(
    url: string,
  ): Promise<{ url: string; file?: File; error?: string }> {
    if (!this.isValidUrl(url)) {
      return { url, error: 'Invalid URL' };
    }

    try {
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
      });

      if (!response.ok) {
        return { url, error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return { url, error: 'URL did not return an image' };
      }

      const blob = await response.blob();

      if (this.maxSizeValue && blob.size > this.maxSizeValue) {
        return { url, error: 'File too large' };
      }

      const filename = this.extractFilename(url, contentType);

      if (this.acceptValue) {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const allowed = this.acceptValue.split(',').map((e) => e.trim());
        if (ext && !allowed.includes(ext)) {
          return { url, error: `File type .${ext} is not allowed` };
        }
      }

      const file = new File([blob], filename, { type: blob.type });
      return { url, file };
    } catch {
      return {
        url,
        error:
          'Could not fetch image. The server may not allow cross-origin requests.',
      };
    }
  }

  // ---- Delivery (event dispatch or direct file input) ----------------

  private deliverFile(file: File) {
    if (this.fileSelectorValue) {
      const fileInput = document.querySelector<HTMLInputElement>(
        this.fileSelectorValue,
      );
      if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      this.dispatch('add', { detail: { file }, bubbles: true });
    }
  }

  // ---- UI helpers ----------------------------------------------------

  private setLoading(active: boolean) {
    if (active) {
      this.submitTarget.setAttribute('disabled', '');
      this.submitTarget.classList.add('button-longrunning-active');
    } else {
      this.submitTarget.removeAttribute('disabled');
      this.submitTarget.classList.remove('button-longrunning-active');
    }
  }

  private clearErrors() {
    this.errorsTarget.hidden = true;
    this.errorsTarget.innerHTML = '';
  }

  private showErrors(messages: string[]) {
    this.errorsTarget.hidden = false;
    this.errorsTarget.innerHTML = messages
      .map(
        (msg) =>
          `<p class="error-message">${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
      )
      .join('');
  }

  // ---- Utilities -----------------------------------------------------

  private isValidUrl(input: string): boolean {
    try {
      const parsed = new URL(input);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private extractFilename(url: string, contentType: string): string {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/');
      const last = segments[segments.length - 1];
      if (last && last.includes('.')) {
        return decodeURIComponent(last);
      }
    } catch {
      // fall through
    }

    const ext = this.mimeToExtension(contentType);
    return `imported-image${ext}`;
  }

  private mimeToExtension(mime: string): string {
    const base = mime.split(';')[0].trim();
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/avif': '.avif',
      'image/svg+xml': '.svg',
      'image/heic': '.heic',
    };
    return map[base] || '.jpg';
  }
}
