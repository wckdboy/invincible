//! The `invincible` command.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use invincible::config::{self, Config};
use invincible::engine::{self, Engine, Launch};
use invincible::server::{self, AppState};
use invincible::token;
use invincible_policy::{RouteInput, decide};

#[derive(Parser)]
#[command(version, about = "Intelligence that never relies solely on frontier labs, corporations or countries.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the node: start the engines and serve the local API.
    Serve {
        /// The configuration file [default: $INVINCIBLE_HOME/config.toml].
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Print the local API token (created on first use).
    Token,
    /// Print where a request would run, given a routing input (spec/routing.md) as JSON.
    Route {
        /// The input file; reads stdin when absent or `-`.
        file: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("invincible: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Serve { config } => {
            let home = config::home()?;
            let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
            let token = token::load_or_create(&home.join("token"))?;
            tracing_subscriber::fmt().with_target(false).init();
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(serve(config, token, home))
        }
        Command::Token => {
            println!("{}", token::load_or_create(&config::home()?.join("token"))?);
            Ok(())
        }
        Command::Route { file } => {
            let text = match file.filter(|f| f.as_os_str() != "-") {
                Some(path) => std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?,
                None => {
                    let mut text = String::new();
                    std::io::stdin().read_to_string(&mut text).map_err(|e| format!("stdin: {e}"))?;
                    text
                }
            };
            let input: RouteInput = serde_json::from_str(&text).map_err(|e| format!("routing input: {e}"))?;
            let decision = serde_json::to_string_pretty(&decide(&input)).map_err(|e| e.to_string())?;
            println!("{decision}");
            Ok(())
        }
    }
}

async fn serve(config: Config, token: String, home: PathBuf) -> Result<(), String> {
    let logs = home.join("logs");
    let mut engines = Vec::new();
    // Held until shutdown: dropping a supervisor kills its engine.
    let mut supervisors = Vec::new();
    for model in &config.models {
        let port = engine::free_port().map_err(|e| format!("no free port: {e}"))?;
        let engine = Engine::attached(&model.id, &format!("http://127.0.0.1:{port}"), model.context, false);
        supervisors.push(engine::supervise(engine.clone(), Launch::llama_server(&config.engine, model, port, &logs)));
        engines.push(engine);
    }
    if engines.is_empty() {
        tracing::warn!("no models configured: every request will be blocked (add [[models]] to the config)");
    }

    let state = Arc::new(AppState::new(engines, config.node.settings(), token));
    let listener =
        tokio::net::TcpListener::bind(config.listen).await.map_err(|e| format!("listen on {}: {e}", config.listen))?;
    tracing::info!("serving on http://{}", config.listen);
    axum::serve(listener, server::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())?;
    for supervisor in supervisors {
        supervisor.abort();
    }
    Ok(())
}
