use flate2::read::GzDecoder;
use std::env;
use std::fs::{self, File};
use std::path::PathBuf;
use tar::Archive;

fn main() {
    // TODO: find out if liblsl already present on system and usable (if so, link to that instead)
    // println!("cargo:warning={}", "rebuilding...");
    build_liblsl();
}

// Build the liblsl library from source using cmake
fn build_liblsl() {
    let target = env::var("TARGET").unwrap();
    let liblsl_source = unpack_liblsl();
    
    // build with cmake
    let mut cfg = cmake::Config::new(liblsl_source);
    cfg
        .define("LSL_NO_FANCY_LIBNAME", "ON")
        .define("LSL_BUILD_STATIC", "ON");
    if target.contains("msvc") {
        // override some C/CXX flags that the cmake crate splices in on Windows
        // (these cause the build to fail)...
        // * /EHsc sets the correct exception handling mode
        // * /GR enables RTTI
        // * /MD links in the msvcrt as a DLL instead of statically
        let cxx_args = " /nologo /EHsc /MD /GR";
        cfg 
            .define("WIN32", "1")
            .define("_WINDOWS", "1")
            .define("CMAKE_C_FLAGS", cxx_args)
            .define("CMAKE_CXX_FLAGS", cxx_args)
            .define("CMAKE_C_FLAGS_DEBUG", cxx_args)
            .define("CMAKE_CXX_FLAGS_DEBUG", cxx_args)
            .define("CMAKE_C_FLAGS_RELEASE", cxx_args)
            .define("CMAKE_CXX_FLAGS_RELEASE", cxx_args);
    } else if target.contains("apple") {
        // liblsl 1.13 bundles an older Boost.MPL implementation. Apple Clang 16+
        // promotes this formerly accepted enum constexpr conversion to an error.
        // The conversion is intentional Boost template metaprogramming, so keep
        // the upstream source unchanged and disable only this diagnostic.
        cfg.define(
            "CMAKE_CXX_FLAGS",
            "-Wno-enum-constexpr-conversion -Wno-deprecated-declarations",
        );
    }
    let install_dir = cfg.build();

    // emit link directives
    let libdir = install_dir.join("lib");
    let libname = "lsl-static";
    println!(
        "cargo:rustc-link-search=native={}",
        libdir.to_str().unwrap()
    );
    println!("cargo:rustc-link-lib=static={}", libname);

    // make sure we also link some additional libs
    if target.contains("linux") {
        println!("cargo:rustc-link-lib=dylib=stdc++");
    } else if target.contains("windows") {
        // TODO: this is a shortcoming in the current cmake file, which should be       
        //       linking in this library (once this is fixed, we should remove this)
        println!("cargo:rustc-link-lib=dylib=bcrypt");
    } else {
        println!("cargo:rustc-link-lib=dylib=c++");
    }
}

fn unpack_liblsl() -> PathBuf {
    println!("cargo:rerun-if-changed=liblsl.tar.gz");
    let destination = PathBuf::from(env::var("OUT_DIR").unwrap()).join("liblsl-source");
    let source = destination.join("liblsl");
    if source.join("CMakeLists.txt").is_file() {
        return source;
    }
    if destination.exists() {
        fs::remove_dir_all(&destination).expect("failed to clear stale liblsl source");
    }
    fs::create_dir_all(&destination).expect("failed to create liblsl source directory");
    let archive = File::open("liblsl.tar.gz").expect("failed to open bundled liblsl source");
    Archive::new(GzDecoder::new(archive))
        .unpack(&destination)
        .expect("failed to unpack bundled liblsl source");
    source
}
