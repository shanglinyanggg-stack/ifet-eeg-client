import {resolveMicrovoltsPerCount,type SignalDisplaySettings} from '../domain/signal-display';
import {ThemedSelect} from './ThemedSelect';
export function SignalCalibrationSettings({settings,onChange}:{settings:SignalDisplaySettings;onChange:(settings:SignalDisplaySettings)=>void}){
  const update=(patch:Partial<SignalDisplaySettings>)=>onChange({...settings,...patch});
  const coefficient=resolveMicrovoltsPerCount(settings);
  const number=(value:string)=>value.trim()&&Number.isFinite(Number(value))?Number(value):null;
  return <section className="setting-group signal-calibration" aria-label="EEG单位标定">
    <h3>EEG纵轴与电压标定</h3>
    <p className="setting-help">仅改变显示。CSV与LSL保持原始ADC计数；PPG和加速度不换算为EEG微伏。禁止使用未经确认的参考电压或增益。</p>
    <p className="setting-help">当前使用四通道共享系数；只有EEG1–4增益一致时才能使用。若各通道增益不同，请保持ADC显示。</p>
    <label className="field-control"><span>换算依据</span><ThemedSelect ariaLabel="微伏换算方式" value={settings.calibrationMode}
      options={[{value:'coefficient',label:'已知µV/ADC系数（推荐）'},{value:'bipolar24',label:'双极性24位ADC：Vref与总增益'}]}
      onChange={value=>update({calibrationMode:value as SignalDisplaySettings['calibrationMode'],calibrationConfirmed:false})}/></label>
    {settings.calibrationMode==='coefficient'?<label>µV / ADC计数<input aria-label="微伏每ADC计数" type="number" min="0" step="any"
      value={settings.microvoltsPerCount??''} placeholder="由固件或标定实验提供"
      onChange={event=>update({microvoltsPerCount:number(event.target.value),calibrationConfirmed:false})}/></label>:
      <><div className="two-col"><label>参考电压Vref（V）<input type="number" step="any" min="0" value={settings.referenceVolts??''}
        onChange={event=>update({referenceVolts:number(event.target.value),calibrationConfirmed:false})}/></label>
        <label>总模拟增益<input type="number" step="any" min="0" value={settings.totalGain??''}
        onChange={event=>update({totalGain:number(event.target.value),calibrationConfirmed:false})}/></label></div>
        <p className="setting-help">仅适用于未被固件缩放的24位双极性二补码：µV/ADC = Vref / (总增益 × 2²³) × 10⁶。若有额外缩放，请使用直接标定系数。</p></>}
    <label>标定来源<input value={settings.calibrationNote} placeholder="设备型号、固件版本或标定日期"
      onChange={event=>update({calibrationNote:event.target.value})}/></label>
    <label className="check-row"><input type="checkbox" checked={settings.calibrationConfirmed}
      onChange={event=>update({calibrationConfirmed:event.target.checked})}/>已确认系数与当前设备/增益匹配</label>
    <div className="calibration-result" data-ready={coefficient!==null}>{coefficient===null?'未标定：µV显示不可用':
      `已标定 · 1 ADC = ${coefficient.toPrecision(7)} µV`}</div>
    <small className="setting-help">软件无法从现有BLE协议读取ADC参考电压与增益；更换设备或增益后，请重新核对标定。</small>
  </section>;
}
