export interface BleDiagnostics {
  linkRequestStatus?:string;connectionIntervalMs?:number|null;peripheralLatency?:number|null;
  receivedSlotRateHz?:number;usableEegSampleRateHz?:number;zeroAdcSlots?:number;identicalAdjacentAdcSlots?:number;suspiciousNotifications?:number;rtcRaw?:number|null;
  windowSeconds?:number;transmitIntervalMs?:number;expectedSamplesPerNotification?:number;packingConfirmed?:boolean;
  notificationRateHz:number;observedSampleRateHz:number;logicalSampleRateHz:number;requestedSampleRateHz:number;
  samplesPerNotification:number;bufferedNotifications:number;processingDelayMs:number;peakProcessingDelayMs:number;rejectedNotifications:number;
}
