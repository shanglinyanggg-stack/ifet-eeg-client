#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ifet_eeg_client::run();
}
