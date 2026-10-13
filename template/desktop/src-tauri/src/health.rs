// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Free port allocation and raw-HTTP health probing (no HTTP client dependency).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// `n` distinct free loopback ports (the listeners are held until all are allocated, so none repeats).
pub fn free_ports(n: usize) -> std::io::Result<Vec<u16>> {
    let listeners = (0..n).map(|_| TcpListener::bind(("127.0.0.1", 0))).collect::<Result<Vec<_>, _>>()?;
    listeners.iter().map(|l| l.local_addr().map(|a| a.port())).collect()
}

/// Minimal `GET` request for `path` on the loopback host.
pub fn health_request(path: &str) -> String {
    format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
}

/// True when the start of a response is an HTTP 200 status line.
pub fn is_http_200(head: &[u8]) -> bool {
    head.starts_with(b"HTTP/1.0 200") || head.starts_with(b"HTTP/1.1 200")
}

/// One probe: connects, requests `path`, true on a 200 answer.
pub fn http_ok(port: u16, path: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    if stream.write_all(health_request(path).as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    stream.read(&mut buf).map(|n| is_http_200(&buf[..n])).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn free_port_is_bindable_and_loopback() {
        let p = free_ports(1).unwrap()[0];
        assert!(p > 0);
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn free_ports_are_distinct() {
        let ports = free_ports(5).unwrap();
        let unique: std::collections::HashSet<_> = ports.iter().collect();
        assert_eq!(unique.len(), 5);
        assert!(free_ports(0).unwrap().is_empty());
    }

    #[test]
    fn request_and_status_line() {
        assert!(health_request("/api/v1/health").starts_with("GET /api/v1/health HTTP/1.0\r\n"));
        assert!(is_http_200(b"HTTP/1.1 200 OK"));
        assert!(is_http_200(b"HTTP/1.0 200 OK"));
        assert!(!is_http_200(b"HTTP/1.1 503 Service"));
        assert!(!is_http_200(b""));
    }

    fn serve_once(status: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 256];
                let _ = s.read(&mut buf);
                let _ = s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
            }
        });
        port
    }

    #[test]
    fn probe_distinguishes_200_from_errors_and_closed_ports() {
        assert!(http_ok(serve_once("200 OK"), "/h"));
        assert!(!http_ok(serve_once("503 Service Unavailable"), "/h"));
        let closed = free_ports(1).unwrap()[0];
        assert!(!http_ok(closed, "/h"));
    }
}
