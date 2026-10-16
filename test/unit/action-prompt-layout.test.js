// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountSpaceActionPrompt } from '../../shared/arcify-space-actions-ui.js';
import { mountTabActionPrompt } from '../../shared/arcify-tab-actions-ui.js';

const duplicateName = `Navigation Duplicate destination ${'unbroken'.repeat(24)}`;
const navigation = { destinations: [
    { spaceId: '5d7a0aae-992e-4595-b545-e2a28a39b958', bookmarkFolderId: 'first-root', name: duplicateName },
    { spaceId: 'f897364c-2a4d-4c85-a6d1-891761a254ed', bookmarkFolderId: 'second-root', name: duplicateName }
] };
const savedTitle = 'UnbrokenSavedTitle'.repeat(15);
const savedUrl = `https://example.test/${'long-path-segment'.repeat(900)}`;
const saved = { tab: { section: 'saved', bookmark: { title: savedTitle, url: savedUrl } } };
const today = { tab: { section: 'today', alias: '', title: savedTitle } };
const prompts = [];

afterEach(() => {
    prompts.splice(0).forEach(prompt => prompt.dispose());
    document.body.replaceChildren();
});

function surface(isolated) {
    let owner = document;
    if (isolated) {
        const frame = document.createElement('iframe');
        frame.style.width = '650px';
        document.body.append(frame);
        owner = frame.contentDocument;
    }
    const parent = owner.createElement('div'); parent.style.width = '650px';
    const wrapper = owner.createElement('div'), input = owner.createElement('input');
    input.value = 'Preserve the exact source query';
    wrapper.append(input); parent.append(wrapper); owner.body.append(parent);
    return { owner, parent, wrapper, input };
}

// jsdom verifies the sizing contract, full text, and focus behavior only.
// Actual visible rectangles/overflow require the paired Chrome acceptance checks.
function expectBoundedStyles(owner, dialog) {
    const computed = element => owner.defaultView.getComputedStyle(element);
    const layout = computed(dialog);
    expect(layout.gridTemplateColumns.replaceAll(' ', '')).toBe('minmax(0,1fr)');
    expect(layout.display).toBe('grid');
    expect(layout.minWidth).toBe('0');
    expect(layout.maxWidth).toBe('100%');
    expect(layout.boxSizing).toBe('border-box');
    expect(layout.padding).toBe('16px 20px');
    expect(layout.backgroundColor).toBe('rgb(45, 45, 45)');
    expect(layout.color).toBe('rgb(255, 255, 255)');
    expect(layout.fontSize).toBe('14px');
    expect(layout.fontFamily).toBe('system-ui');
    for (const child of dialog.querySelectorAll(':scope > :not(style), button')) {
        const style = computed(child);
        expect(style.minWidth).toBe('0');
        expect(style.maxWidth).toBe('100%');
        expect(style.boxSizing).toBe('border-box');
        expect(style.overflowWrap).toBe('anywhere');
    }
    for (const control of dialog.querySelectorAll('input, select')) expect(computed(control).width).toBe('100%');
    expect(computed(dialog.querySelector('[data-action-confirm]').parentElement).flexWrap).toBe('wrap');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2').id);
    expect(dialog.getAttribute('aria-describedby')).toBe(dialog.querySelector('p').id);
    expect(dialog.querySelector('style').textContent).toContain(':focus-visible { outline:2px solid #a8c7fa; outline-offset:2px; }');
}

describe.each([['new-tab document', false], ['isolated overlay document', true]])('bounded action prompts in %s', (_, isolated) => {
    it.each(['switchSpace', 'moveCurrentTodayTab', 'createSpaceFolder', 'removeCurrentPin'])('bounds %s without changing full names, IDs, or source draft', async command => {
        const { owner, parent, wrapper, input } = surface(isolated);
        const prompt = mountSpaceActionPrompt(parent, input); prompts.push(prompt);
        const before = structuredClone({ saved, navigation });
        const result = prompt.show(command, saved, navigation);
        const dialog = parent.querySelector('.arcify-space-action-prompt');
        expectBoundedStyles(owner, dialog);
        expect(wrapper.hidden).toBe(true);
        const select = dialog.querySelector('select');
        if (select) {
            expect([...select.options].map(option => option.textContent)).toEqual([
                'Choose a Space…', ...navigation.destinations.map(target => `${target.name} (${target.spaceId})`)
            ]);
            expect(select.value).toBe('');
            select.value = '1';
            expect(select.selectedOptions[0].textContent).toBe(`${duplicateName} (${navigation.destinations[1].spaceId})`);
            expect(owner.activeElement).toBe(select);
        } else if (command === 'removeCurrentPin') {
            expect(dialog.querySelector('p').textContent).toContain(savedTitle);
            expect(owner.activeElement).toBe(dialog.querySelector('[data-action-cancel]'));
        } else {
            expect(owner.activeElement).toBe(dialog.querySelector('input'));
        }
        const first = dialog.querySelector('select, input, [data-action-cancel]');
        const confirm = dialog.querySelector('[data-action-confirm]');
        confirm.focus();
        confirm.dispatchEvent(new owner.defaultView.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(owner.activeElement).toBe(first);
        prompt.cancel(); expect(await result).toBeNull();
        expect(parent.querySelector('[role="dialog"]')).toBeNull();
        expect(wrapper.hidden).toBe(false); expect(owner.activeElement).toBe(input);
        expect(input.value).toBe('Preserve the exact source query');
        expect({ saved, navigation }).toEqual(before);
    });

    it.each([
        ['renameCurrentTab', today, savedTitle],
        ['renameCurrentTab', saved, savedTitle],
        ['editCurrentPinUrl', saved, savedUrl]
    ])('bounds %s with the full existing value and original keyboard focus', async (command, context, value) => {
        const { owner, parent, wrapper, input } = surface(isolated);
        const prompt = mountTabActionPrompt(parent, input); prompts.push(prompt);
        const before = structuredClone(context);
        const result = prompt.show(command, context);
        const dialog = parent.querySelector('.arcify-tab-action-prompt');
        expectBoundedStyles(owner, dialog);
        const control = dialog.querySelector('[data-tab-action-input]');
        expect(control.value).toBe(value); expect(owner.activeElement).toBe(control);
        expect(control.selectionStart).toBe(0); expect(control.selectionEnd).toBe(value.length);
        expect(wrapper.hidden).toBe(true);
        control.dispatchEvent(new owner.defaultView.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(owner.activeElement).toBe(dialog.querySelector('[data-action-confirm]'));
        prompt.cancel(); expect(await result).toBeNull();
        expect(wrapper.hidden).toBe(false); expect(owner.activeElement).toBe(input);
        expect(input.value).toBe('Preserve the exact source query'); expect(context).toEqual(before);
    });
});
