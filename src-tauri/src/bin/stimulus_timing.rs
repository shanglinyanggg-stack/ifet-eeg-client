fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("Usage: stimulus_timing NEW_OUTPUT_DIRECTORY [trials=40]"))?;
    let trials = std::env::args().nth(2).unwrap_or_else(|| "40".into()).parse()?;
    let path = std::path::Path::new(&path);
    if path.exists() { anyhow::bail!("Output already exists; choose a new directory"); }
    let report = ifet_eeg_client::stimulation::benchmark(path, trials)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
