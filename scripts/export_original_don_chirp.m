function export_original_don_chirp(outputFile)
% Export the ORIGINAL CochleaChirp function's waveform for the stimulus app.
% Requires the user's original CochleaChirp.m on the MATLAB path.
% This helper does not open serial ports, send TTL, or play audio.
if nargin < 1
    outputFile = 'DonChirp_80Hz_5s_44100Hz.wav';
end
if exist(outputFile, 'file')
    error('Output already exists. Choose a new filename; nothing was overwritten.');
end
if exist('CochleaChirp', 'file') == 0
    error('Add the ORIGINAL CochleaChirp.m to the MATLAB path first.');
end
fs = 44100;
wave = CochleaChirp(5, fs, 80, [20, 20000], 'Don');
if ~isvector(wave) || numel(wave) ~= 5 * fs
    error('Expected a 5-second mono vector, exactly 220500 samples.');
end
wave = double(wave(:));
if ~isreal(wave) || any(~isfinite(wave)) || any(abs(wave) > 1) || ~any(abs(wave) > 1e-6)
    error('Invalid/clipped/silent source. Refusing automatic normalization.');
end
% Same mono signal on both channels, as [audioseq; audioseq] in the original.
% PCM24 introduces only quantization; gain is not normalized or otherwise changed.
audiowrite(outputFile, [wave, wave], fs, 'BitsPerSample', 24);
fprintf('Saved %s: stereo, 44100 Hz, 5 s, original 80 Hz Don chirp.\n', outputFile);
fprintf('App gain defaults to 10%%, unlike the original 100%%. Calibrate sound level separately.\n');
end
