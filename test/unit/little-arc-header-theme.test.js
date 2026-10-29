import {it,expect} from 'vitest';
import {deriveSpaceTheme,contrastRatio} from '../../shared/space-theme-palette.js';
for(const color of ['#cccccc','#8bb3f3','#ff9e97','#ffe29f','#8bda99','#fbaad7','#d6a6ff','#a5e2ea','#000000','#ffffff','#ff0000','#0000ff','#00ff00'])for(const mode of ['light','dark'])it(`readable ${color} ${mode}`,()=>{
 const t=deriveSpaceTheme(color,mode);for(const value of Object.values(t))expect(value).toMatch(/^#[0-9a-f]{6}$/i);
 for(const [bg,fg] of [[t.surface,t.text],[t.secondary,t.text],[t.hover,t.text],[t.selected,t.selectedText],[t.panel,t.panelText],[t.input,t.panelText],[t.surface,t.muted]])expect(contrastRatio(bg,fg)).toBeGreaterThanOrEqual(4.5);
 expect(contrastRatio(t.surface,t.marker)).toBeGreaterThanOrEqual(3);expect(contrastRatio(t.panel,t.panelText)).toBeGreaterThanOrEqual(3);
});
it.each([null,undefined,'red','url(evil)','#000',';--x:red'])('invalid tint %s falls back safely',value=>expect(deriveSpaceTheme(value)).toEqual(deriveSpaceTheme('#cccccc')));
