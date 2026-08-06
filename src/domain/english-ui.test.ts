import { describe, expect, test } from 'vitest';
import { translateEnglishUiText } from './english-ui';

describe('English UI translation', () => {
  test('translates dynamic acquisition status text', () => {
    expect(translateEnglishUiText('已连接 TD10 · 10s 实收 124.8/125 Hz · 丢包 0.2%'))
      .toBe('Connected TD10 · 10s Received 124.8/125 Hz · Packet Loss 0.2%');
  });

  test('translates sleep guidance and calibration instructions', () => {
    expect(translateEnglishUiText('开始助眠')).toBe('Start Sleep Guidance');
    expect(translateEnglishUiText('睁眼基线测量进度 50%'))
      .toBe('Eyes-open Baseline Calibration Progress 50%');
  });

  test('leaves protocol identifiers and values unchanged', () => {
    expect(translateEnglishUiText('EEG1 · FFF5 · 125 Hz')).toBe('EEG1 · FFF5 · 125 Hz');
  });
});
