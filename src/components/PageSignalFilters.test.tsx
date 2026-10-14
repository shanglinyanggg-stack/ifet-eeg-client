import '@testing-library/jest-dom/vitest';
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {afterEach,test,expect,vi} from 'vitest';
import {defaultSettings} from '../domain/settings';
import {PageSignalFilters} from './PageSignalFilters';
afterEach(cleanup);
test('changes only the visible page and exposes its parameters locally',()=>{
  const change=vi.fn();render(<PageSignalFilters page="eeg" settings={defaultSettings} onChange={change}/>);
  fireEvent.click(screen.getByLabelText('脑电分析显示滤波开关'));
  const next=change.mock.calls[0][0];expect(next.pageFilters.eeg.enabled).toBe(true);expect(next.pageFilters.sleep).toBe(defaultSettings.pageFilters.sleep);
  fireEvent.click(screen.getByLabelText('脑电分析滤波参数'));
  expect(screen.getByLabelText('本页滤波低频')).toBeInTheDocument();
  expect(screen.getByText(/仅作用于本页主波形/)).toBeInTheDocument();
});
