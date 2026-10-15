import { focusIfLost } from './focus';

describe('focusIfLost', () => {
  afterEach(() => document.body.replaceChildren());

  it('takes focus to the element when nothing has it', () => {
    document.body.innerHTML = '<p tabindex="-1" id="status">Saved</p>';
    const status = document.getElementById('status');
    focusIfLost(status);
    expect(status).toHaveFocus();
  });

  it('leaves focus where the person moved it', () => {
    document.body.innerHTML = '<input id="field" /><p tabindex="-1" id="status">Saved</p>';
    const field = document.getElementById('field');
    field?.focus();
    focusIfLost(document.getElementById('status'));
    expect(field).toHaveFocus();
  });

  it('does nothing without an element', () => {
    expect(() => focusIfLost(null)).not.toThrow();
  });
});
