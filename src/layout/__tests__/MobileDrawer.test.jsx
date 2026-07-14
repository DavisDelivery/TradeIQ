import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MobileDrawer } from '../MobileDrawer.jsx';
import { Activity, Bell } from 'lucide-react';

const VIEWS = [
  { id: 'desk', label: 'Desk', shortLabel: 'Desk', icon: Activity },
  { id: 'alerts', label: 'Alerts', shortLabel: 'Alerts', icon: Bell },
  { id: 'williams', label: 'Williams', shortLabel: 'Williams', icon: Activity, section: 'unvalidated' },
];

function renderDrawer(overrides = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    views: VIEWS,
    activeView: 'desk',
    setActiveView: vi.fn(),
    appVersion: '0.0.0-test',
    ...overrides,
  };
  render(<MobileDrawer {...props} />);
  return props;
}

afterEach(cleanup);

describe('MobileDrawer', () => {
  it('renders every view, with the unvalidated section divider', () => {
    renderDrawer();
    expect(screen.getByText('Desk')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Williams')).toBeInTheDocument();
    expect(screen.getByText('Unvalidated')).toBeInTheDocument();
  });

  it('selecting a view navigates AND closes the drawer', () => {
    const p = renderDrawer();
    fireEvent.click(screen.getByText('Alerts'));
    expect(p.setActiveView).toHaveBeenCalledWith('alerts');
    expect(p.onClose).toHaveBeenCalled();
  });

  it('backdrop click and Escape both close', () => {
    const p = renderDrawer();
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('marks the active view with aria-current', () => {
    renderDrawer({ activeView: 'alerts' });
    expect(screen.getByText('Alerts').closest('button')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Desk').closest('button')).not.toHaveAttribute('aria-current');
  });

  it('locks body scroll while open and restores it on unmount', () => {
    const { unmount } = render(
      <MobileDrawer open onClose={() => {}} views={VIEWS} activeView="desk" setActiveView={() => {}} appVersion="t" />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
