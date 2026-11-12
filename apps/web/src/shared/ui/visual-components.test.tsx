import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from './button';
import { Card } from './card';
import { RingGauge } from './ring-gauge';
import { SearchInput } from './search-input';
import { StatCard } from './stat-card';
import { StatusBadge, type StatusTone } from './status-badge';
import { Switch } from './switch';

const TONES: StatusTone[] = ['success', 'warning', 'danger', 'info', 'neutral'];

describe.each(['light', 'dark'])('shared visual components, %s', (mode) => {
  beforeEach(() => document.documentElement.classList.toggle('dark', mode === 'dark'));
  afterEach(() => document.documentElement.classList.remove('dark'));

  it('has no axe violations', async () => {
    render(
      <MemoryRouter>
        <main>
          <Card variant="raised">Raised</Card>
          <Card variant="brand">Brand</Card>
          <StatCard id="w" title="Widget" to="/x" linkLabel="Open">
            body
          </StatCard>
          {TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone} label={`Tone ${tone}`} />
          ))}
          <Switch aria-label="Notifications" />
          <RingGauge value={64} label="Occupancy" tone="warning" />
          <SearchInput aria-label="Search" />
          <Button variant="brand">Go</Button>
        </main>
      </MemoryRouter>,
    );
    await expectNoAxeViolations();
  });
});

describe('Switch', () => {
  it('toggles with Space and takes focus', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Notifications" />);
    const toggle = screen.getByRole('switch', { name: 'Notifications' });
    await user.tab();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps focus and ignores presses while aria-disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Busy" aria-disabled onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole('switch', { name: 'Busy' });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(toggle).not.toBeDisabled();
  });
});

describe('RingGauge', () => {
  it('is an image named with its value and clamps', () => {
    render(<RingGauge value={140} label="Occupancy" />);
    expect(screen.getByRole('img', { name: 'Occupancy: 100%' })).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('always says the word', () => {
    render(<StatusBadge tone="danger" label="Blocked" />);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });
});

describe('SearchInput', () => {
  it('is a search field that reports typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchInput aria-label="Find" onChange={onChange} />);
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
