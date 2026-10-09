import { applyTheme, resetTheme } from './theme';

describe('applyTheme', () => {
  afterEach(() => resetTheme());

  it('re-themes at runtime by writing CSS variables', () => {
    applyTheme({ primary: 'oklch(0.55 0.2 25)', radius: '0.75rem' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--primary')).toBe('oklch(0.55 0.2 25)');
    expect(style.getPropertyValue('--radius')).toBe('0.75rem');
  });

  it('ignores unsafe values', () => {
    applyTheme({ primary: 'red; background: url(https://evil.example)' });
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
  });

  it('resets overrides', () => {
    applyTheme({ primary: '#123456' });
    resetTheme();
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
  });
});
