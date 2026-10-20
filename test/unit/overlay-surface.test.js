// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { containOverlayFocus, createOverlaySurface, isComposingKey } from '../../shared/overlay-surface.js';

let frameWindow;
beforeEach(() => {
    frameWindow = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.test' }).window;
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(frameWindow.document);
});
afterEach(() => {
    document.body.replaceChildren();
    frameWindow.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('overlay document surface', () => {
    it('owns a titled frame with no source, remote navigation, script, or message bridge', () => {
        const surface = createOverlaySurface('body { margin: 0; }', ':root { --accent: red; }', '<input aria-label="Search">');
        expect(surface.dialog.getAttribute('aria-label')).toBe('Spotlight');
        expect(surface.frame.title).toBe('Spotlight search');
        expect(surface.frame.hasAttribute('src')).toBe(false);
        expect(surface.frame.hasAttribute('srcdoc')).toBe(false);
        expect(surface.frameDocument.querySelectorAll('script')).toHaveLength(0);
        expect(surface.frameDocument.querySelectorAll('input')).toHaveLength(1);
        expect(surface.dialog.querySelector('input')).toBeNull();
        surface.dispose();
    });
    it('resizes both up and down from content height and disconnects its observer', () => {
        let callback;
        const observe = vi.fn(), disconnect = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(onResize) { callback = onResize; }
            observe = observe;
            disconnect = disconnect;
        });
        const surface = createOverlaySurface('', '', '<input>');
        expect(observe.mock.calls[0]?.[0]).toBe(surface.content);
        const measurement = vi.spyOn(surface.content, 'getBoundingClientRect');
        measurement.mockReturnValue({ height: 237.3 }); callback();
        expect(surface.frame.style.height).toBe('238px');
        measurement.mockReturnValue({ height: 84 }); callback();
        expect(surface.frame.style.height).toBe('84px');
        surface.dispose();
        expect(disconnect).toHaveBeenCalledOnce();
    });
    it('removes an attached partial host if document initialization fails', () => {
        vi.spyOn(frameWindow.document, 'createElement').mockImplementation(() => { throw new Error('DOM refused'); });
        expect(() => createOverlaySurface('', '', '<input>')).toThrow('DOM refused');
        expect(document.getElementById('arcify-spotlight-host')).toBeNull();
    });
});

describe('frame focus containment', () => {
    it('wraps Tab/Shift+Tab around enabled visible controls, preserves intermediate Tab, and cleans up', () => {
        const doc = frameWindow.document;
        doc.body.innerHTML = '<input><button disabled>Disabled</button><button hidden>Hidden</button><button>Result</button><button>Settings</button>';
        vi.spyOn(frameWindow.HTMLElement.prototype, 'getClientRects').mockImplementation(function () { return this.hidden ? [] : [{}]; });
        const input = doc.querySelector('input');
        const [result, settings] = [...doc.querySelectorAll('button')].slice(2);
        const close = vi.fn();
        const remove = containOverlayFocus(doc, close);
        const key = (value, extra = {}) => {
            const event = new frameWindow.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
            doc.activeElement.dispatchEvent(event);
            return event;
        };
        input.focus();
        expect(key('Tab').defaultPrevented).toBe(false);
        expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
        expect(doc.activeElement).toBe(settings);
        expect(key('Tab').defaultPrevented).toBe(true);
        expect(doc.activeElement).toBe(input);
        result.focus();
        expect(key('Tab').defaultPrevented).toBe(false);
        settings.focus();
        expect(key('Escape').defaultPrevented).toBe(true);
        expect(close).toHaveBeenCalledOnce();
        remove();
        expect(key('Escape').defaultPrevented).toBe(false);
        expect(close).toHaveBeenCalledOnce();
    });
    it('does not intercept modified navigation, IME, or ordinary editing events', () => {
        const close = vi.fn();
        const remove = containOverlayFocus(frameWindow.document, close);
        for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            const event = new frameWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...extra });
            frameWindow.document.body.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(close).not.toHaveBeenCalled();
        expect(isComposingKey({ isComposing: true })).toBe(true);
        expect(isComposingKey({ keyCode: 229 })).toBe(true);
        remove();
    });
});
