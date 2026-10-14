import '@testing-library/jest-dom/vitest';
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {afterEach,test,expect} from 'vitest';
import {SpectrumChart} from './SpectrumChart';
afterEach(cleanup);
test('offers an enlarged frequency plot without altering source data',()=>{
  const values=Array.from({length:1250},(_,index)=>({timestamp:100000+index*8,value:Math.sin(2*Math.PI*10*index/125)}));
  const before=values.map(point=>({...point}));
  render(<SpectrumChart values={values} sampleRateHz={125} channelLabel="EEG1"/>);
  fireEvent.click(screen.getByRole('button',{name:'放大频谱'}));
  expect(screen.getByLabelText('EEG1 实时频谱')).toHaveClass('is-expanded');
  expect(screen.getByLabelText('频谱分析时间轴')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'关闭放大频谱'}));
  expect(screen.getByLabelText('EEG1 实时频谱')).not.toHaveClass('is-expanded');expect(values).toEqual(before);
});
