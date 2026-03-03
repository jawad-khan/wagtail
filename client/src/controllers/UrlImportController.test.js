import { Application } from '@hotwired/stimulus';
import { UrlImportController } from './UrlImportController';

// DataTransfer is not implemented in jsdom; provide a minimal stand-in
// so the controller code can construct one without throwing.
if (typeof globalThis.DataTransfer === 'undefined') {
  globalThis.DataTransfer = class DataTransfer {
    constructor() {
      this._files = [];
      this.items = { add: (file) => this._files.push(file) };
    }
    get files() {
      return this._files;
    }
  };
}

describe('UrlImportController', () => {
  let application;
  let originalFetch;

  const setup = async (html) => {
    document.body.innerHTML = `<main>${html}</main>`;
    application = Application.start();
    application.register('w-url-import', UrlImportController);
    await Promise.resolve();
  };

  const getController = () => {
    const element = document.querySelector('[data-controller="w-url-import"]');
    return application.getControllerForElementAndIdentifier(
      element,
      'w-url-import',
    );
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    application?.stop();
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  const baseHTML = `
    <div
      data-controller="w-url-import"
      data-w-url-import-accept-value="jpg,png,gif,webp"
      data-w-url-import-max-size-value="10485760"
    >
      <textarea data-w-url-import-target="input"></textarea>
      <button
        type="button"
        data-action="click->w-url-import#performImport"
        data-w-url-import-target="submit"
      >Import</button>
      <div data-w-url-import-target="errors" hidden></div>
    </div>
  `;

  const makeFetchResponse = (body, contentType = 'image/png', status = 200) => {
    const blob = new Blob([body], { type: contentType });
    const headers = new Map([['content-type', contentType]]);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) || '' },
      blob: () => Promise.resolve(blob),
    });
  };

  const collectEvents = () => {
    const element = document.querySelector('[data-controller="w-url-import"]');
    const events = [];
    element.addEventListener('w-url-import:add', (e) => events.push(e));
    return events;
  };

  describe('single URL import', () => {
    it('should fetch a valid image URL and dispatch an add event', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      document.querySelector('textarea').value =
        'https://example.com/photo.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('image-data'));

      await getController().performImport();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example.com/photo.png',
        { mode: 'cors', credentials: 'omit', redirect: 'follow' },
      );
      expect(events).toHaveLength(1);
      expect(events[0].detail.file).toBeInstanceOf(File);
      expect(events[0].detail.file.name).toBe('photo.png');
      expect(events[0].detail.file.type).toBe('image/png');
    });

    it('should clear the textarea on success', async () => {
      await setup(baseHTML);

      const textarea = document.querySelector('textarea');
      textarea.value = 'https://example.com/photo.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('image-data'));

      await getController().performImport();

      expect(textarea.value).toBe('');
    });
  });

  describe('multiple URL import', () => {
    it('should dispatch one event per successfully fetched URL', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      document.querySelector('textarea').value =
        'https://example.com/a.png\nhttps://example.com/b.jpg\nhttps://example.com/c.gif';
      globalThis.fetch = jest.fn().mockImplementation((url) =>
        makeFetchResponse(
          'data',
          url.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        ),
      );

      await getController().performImport();

      expect(events).toHaveLength(3);
      expect(events[0].detail.file.name).toBe('a.png');
      expect(events[1].detail.file.name).toBe('b.jpg');
      expect(events[2].detail.file.name).toBe('c.gif');
    });

    it('should keep failed URLs in the textarea on partial failure', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      const textarea = document.querySelector('textarea');
      textarea.value =
        'https://example.com/good.png\nhttps://example.com/bad.png';
      globalThis.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('bad')) {
          return Promise.reject(new Error('Network error'));
        }
        return makeFetchResponse('data');
      });

      await getController().performImport();

      expect(events).toHaveLength(1);
      expect(textarea.value).toBe('https://example.com/bad.png');
    });

    it('should skip blank lines', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      document.querySelector('textarea').value =
        'https://example.com/a.png\n\n  \nhttps://example.com/b.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data'));

      await getController().performImport();

      expect(events).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('should show an error for invalid URLs', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value = 'not-a-valid-url';
      globalThis.fetch = jest.fn();

      await getController().performImport();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('Invalid URL');
    });

    it('should show an error when fetch fails (CORS / network)', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value =
        'https://cors-blocked.example.com/image.png';
      globalThis.fetch = jest
        .fn()
        .mockRejectedValue(new TypeError('Failed to fetch'));

      await getController().performImport();

      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('cross-origin');
    });

    it('should show an error for non-image content types', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value =
        'https://example.com/page.html';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('html', 'text/html'));

      await getController().performImport();

      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('did not return an image');
    });

    it('should show an error for HTTP error responses', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value =
        'https://example.com/missing.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('', 'text/plain', 404));

      await getController().performImport();

      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('HTTP 404');
    });

    it('should show an error for files exceeding maxSize', async () => {
      await setup(`
        <div
          data-controller="w-url-import"
          data-w-url-import-accept-value="jpg,png"
          data-w-url-import-max-size-value="10"
        >
          <textarea data-w-url-import-target="input"></textarea>
          <button type="button"
            data-action="click->w-url-import#performImport"
            data-w-url-import-target="submit"
          >Import</button>
          <div data-w-url-import-target="errors" hidden></div>
        </div>
      `);

      document.querySelector('textarea').value =
        'https://example.com/big.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('a'.repeat(100)));

      await getController().performImport();

      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('too large');
    });

    it('should show an error for disallowed file extensions', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value =
        'https://example.com/file.bmp';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data', 'image/bmp'));

      await getController().performImport();

      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );
      expect(errors.hidden).toBe(false);
      expect(errors.textContent).toContain('not allowed');
    });

    it('should clear previous errors on a new import', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      const textarea = document.querySelector('textarea');
      const errors = document.querySelector(
        '[data-w-url-import-target="errors"]',
      );

      textarea.value = 'bad-url';
      globalThis.fetch = jest.fn();
      await getController().performImport();
      expect(errors.hidden).toBe(false);

      textarea.value = 'https://example.com/ok.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data'));

      await getController().performImport();

      expect(errors.hidden).toBe(true);
      expect(errors.innerHTML).toBe('');
      expect(events).toHaveLength(1);
    });
  });

  describe('loading state', () => {
    it('should disable the submit button during import and re-enable after', async () => {
      await setup(baseHTML);

      document.querySelector('textarea').value =
        'https://example.com/photo.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data'));

      const button = document.querySelector('button');
      const importPromise = getController().performImport();

      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.classList.contains('button-longrunning-active')).toBe(true);

      await importPromise;

      expect(button.hasAttribute('disabled')).toBe(false);
      expect(button.classList.contains('button-longrunning-active')).toBe(
        false,
      );
    });
  });

  describe('empty input', () => {
    it('should do nothing when the textarea is empty', async () => {
      await setup(baseHTML);

      globalThis.fetch = jest.fn();
      await getController().performImport();

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('chooser mode (fileSelector)', () => {
    it('should set the file on the target file input instead of dispatching', async () => {
      await setup(`
        <div
          data-controller="w-url-import"
          data-w-url-import-accept-value="jpg,png,gif,webp"
          data-w-url-import-max-size-value="10485760"
          data-w-url-import-file-selector-value="#target-file"
        >
          <input type="url" data-w-url-import-target="input" />
          <button type="button"
            data-action="click->w-url-import#performImport"
            data-w-url-import-target="submit"
          >Import</button>
          <div data-w-url-import-target="errors" hidden></div>
        </div>
        <input type="file" id="target-file" />
      `);

      document.querySelector('input[type="url"]').value =
        'https://example.com/photo.png';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data'));

      const fileInput = document.querySelector('#target-file');

      // jsdom does not support DataTransfer / setting .files on inputs,
      // so we intercept the setter to capture the assigned FileList.
      let capturedFiles = null;
      Object.defineProperty(fileInput, 'files', {
        set(value) {
          capturedFiles = value;
        },
        get() {
          return capturedFiles;
        },
        configurable: true,
      });

      const changeSpy = jest.fn();
      fileInput.addEventListener('change', changeSpy);

      const ctrl = getController();
      const element = document.querySelector(
        '[data-controller="w-url-import"]',
      );
      const events = [];
      element.addEventListener('w-url-import:add', (e) => events.push(e));

      await ctrl.performImport();

      expect(events).toHaveLength(0);
      expect(changeSpy).toHaveBeenCalledTimes(1);
      expect(capturedFiles).not.toBeNull();
      expect(capturedFiles[0].name).toBe('photo.png');
    });
  });

  describe('filename extraction', () => {
    it('should extract the filename from the URL path', async () => {
      await setup(baseHTML);
      const events = collectEvents();

      document.querySelector('textarea').value =
        'https://cdn.example.com/uploads/my-photo.jpg';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data', 'image/jpeg'));

      await getController().performImport();

      expect(events).toHaveLength(1);
      expect(events[0].detail.file.name).toBe('my-photo.jpg');
    });

    it('should generate a fallback filename when URL has no extension', async () => {
      await setup(`
        <div
          data-controller="w-url-import"
          data-w-url-import-accept-value=""
        >
          <textarea data-w-url-import-target="input"></textarea>
          <button type="button"
            data-action="click->w-url-import#performImport"
            data-w-url-import-target="submit"
          >Import</button>
          <div data-w-url-import-target="errors" hidden></div>
        </div>
      `);
      const events = collectEvents();

      document.querySelector('textarea').value =
        'https://example.com/image-service/12345';
      globalThis.fetch = jest
        .fn()
        .mockReturnValue(makeFetchResponse('data', 'image/webp'));

      await getController().performImport();

      expect(events).toHaveLength(1);
      expect(events[0].detail.file.name).toBe('imported-image.webp');
    });
  });
});
