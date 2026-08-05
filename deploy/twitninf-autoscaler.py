#!/usr/bin/env python3
"""Autoscaling borné des répliques web TwitNinf sur le VPS A.

Le premier scale-out exige que les backends A et B soient tous les deux en
surcharge. Une fois l'épisode commencé, une surcharge globale persistante peut
ajouter C2 puis C3. Les processus créés ont toujours NODE_ROLE=web et ne
peuvent donc lancer ni PolicierCongo, ni cron, ni migration.
"""

from __future__ import annotations

import argparse
import fcntl
import itertools
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, str(default)))


APP_DIR = Path(os.environ.get("AUTOSCALE_APP_DIR", "/home/debian/api"))
SERVER_SCRIPT = os.environ.get("AUTOSCALE_SERVER_SCRIPT", "src/server.js")
PM2_USER = os.environ.get("AUTOSCALE_PM2_USER", "debian")
PM2_HOME = os.environ.get("AUTOSCALE_PM2_HOME", f"/home/{PM2_USER}/.pm2")
PM2_BIN = os.environ.get("AUTOSCALE_PM2_BIN", "/usr/bin/pm2")

UPSTREAM_INCLUDE = Path(
    os.environ.get(
        "AUTOSCALE_UPSTREAM_INCLUDE",
        "/etc/nginx/twitninf-autoscale-upstreams.conf",
    )
)
METRICS_LOG = Path(
    os.environ.get("AUTOSCALE_METRICS_LOG", "/var/log/nginx/twitninf-upstream.log")
)
STATE_FILE = Path(
    os.environ.get("AUTOSCALE_STATE_FILE", "/var/lib/twitninf-autoscaler/state.json")
)
LOCK_FILE = Path(
    os.environ.get("AUTOSCALE_LOCK_FILE", "/run/lock/twitninf-autoscaler.lock")
)

REPLICAS = (
    {"name": "twitninf-api-c1", "label": "c1", "port": 3005},
    {"name": "twitninf-api-c2", "label": "c2", "port": 3006},
    {"name": "twitninf-api-c3", "label": "c3", "port": 3007},
)
MAX_REPLICAS = min(env_int("AUTOSCALE_MAX_REPLICAS", 3), len(REPLICAS))
REPLICA_BY_LABEL = {str(item["label"]): item for item in REPLICAS[:MAX_REPLICAS]}

WINDOW_SECONDS = env_int("AUTOSCALE_WINDOW_SECONDS", 30)
MIN_REQUESTS_PER_SIDE = env_int("AUTOSCALE_MIN_REQUESTS_PER_SIDE", 30)
HIGH_P95_SECONDS = env_float("AUTOSCALE_HIGH_P95_SECONDS", 0.8)
HIGH_ERROR_RATE = env_float("AUTOSCALE_HIGH_ERROR_RATE", 0.05)
LOW_P95_SECONDS = env_float("AUTOSCALE_LOW_P95_SECONDS", 0.3)
LOW_ERROR_RATE = env_float("AUTOSCALE_LOW_ERROR_RATE", 0.01)
HIGH_STREAK_REQUIRED = env_int("AUTOSCALE_HIGH_STREAK", 2)
LOW_STREAK_REQUIRED = env_int("AUTOSCALE_LOW_STREAK", 60)
SCALE_OUT_COOLDOWN = env_int("AUTOSCALE_OUT_COOLDOWN_SECONDS", 60)
SCALE_IN_COOLDOWN = env_int("AUTOSCALE_IN_COOLDOWN_SECONDS", 600)
MIN_AVAILABLE_BEFORE_MB = env_int("AUTOSCALE_MIN_AVAILABLE_BEFORE_MB", 3500)
MIN_AVAILABLE_AFTER_MB = env_int("AUTOSCALE_MIN_AVAILABLE_AFTER_MB", 2500)
START_TIMEOUT_SECONDS = env_int("AUTOSCALE_START_TIMEOUT_SECONDS", 75)
WARMUP_SECONDS = env_int("AUTOSCALE_WARMUP_SECONDS", 15)
DRAIN_SECONDS = env_int("AUTOSCALE_DRAIN_SECONDS", 15)
MAX_LOG_BYTES = env_int("AUTOSCALE_MAX_LOG_BYTES", 32 * 1024 * 1024)

BASE_A_ADDR = "127.0.0.1:3001"
BASE_B_ADDR = "10.8.0.2:3001"
LOCAL_ADDRS = {BASE_A_ADDR, *(f"127.0.0.1:{r['port']}" for r in REPLICAS)}


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True), flush=True)


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"commande échouée ({result.returncode}): {' '.join(command)}: {detail}")
    return result


def pm2(*args: str, process_env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    assignments = [f"PM2_HOME={PM2_HOME}"]
    assignments.extend(f"{key}={value}" for key, value in (process_env or {}).items())
    command = ["/usr/bin/sudo", "-u", PM2_USER, "/usr/bin/env", *assignments, PM2_BIN, *args]
    return run(command, check=check)


def pm2_processes() -> dict[str, dict[str, Any]]:
    result = pm2("jlist")
    start = result.stdout.find("[")
    if start < 0:
        raise RuntimeError("pm2 jlist n'a pas renvoyé de JSON")
    payload, _ = json.JSONDecoder().raw_decode(result.stdout[start:])
    return {str(item.get("name")): item for item in payload}


def is_pm2_online(processes: dict[str, dict[str, Any]], name: str) -> bool:
    item = processes.get(name, {})
    return item.get("pm2_env", {}).get("status") == "online"


def health(replica: dict[str, Any], timeout: float = 1.5) -> bool:
    url = f"http://127.0.0.1:{replica['port']}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = json.load(response)
        return (
            response.status == 200
            and body.get("success") is True
            and body.get("role") == "web"
            and body.get("policiercongo_local") is False
            and body.get("instance") == f"autoscale-{replica['label']}"
        )
    except Exception:
        return False


def healthy_replicas(processes: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    processes = processes or pm2_processes()
    return [
        replica
        for replica in REPLICAS[:MAX_REPLICAS]
        if is_pm2_online(processes, replica["name"]) and health(replica)
    ]


def upstream_content(replicas: list[dict[str, Any]]) -> str:
    lines = ["# Géré automatiquement par twitninf-autoscaler. Ne pas éditer.\n"]
    for replica in sorted(replicas, key=lambda item: item["port"]):
        lines.append(
            f"server 127.0.0.1:{replica['port']} weight=13 "
            f"max_fails=2 fail_timeout=10s; # {replica['label']}\n"
        )
    return "".join(lines)


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def apply_upstreams(replicas: list[dict[str, Any]]) -> bool:
    new_content = upstream_content(replicas)
    old_content = UPSTREAM_INCLUDE.read_text(encoding="utf-8") if UPSTREAM_INCLUDE.exists() else ""
    if new_content == old_content:
        return True

    atomic_write(UPSTREAM_INCLUDE, new_content)
    tested = run(["/usr/sbin/nginx", "-t"], check=False)
    if tested.returncode != 0:
        atomic_write(UPSTREAM_INCLUDE, old_content)
        emit("nginx_rejected", error=(tested.stderr or tested.stdout).strip())
        return False

    reloaded = run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
    if reloaded.returncode != 0:
        atomic_write(UPSTREAM_INCLUDE, old_content)
        run(["/usr/sbin/nginx", "-t"], check=False)
        run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
        emit("nginx_reload_failed", error=(reloaded.stderr or reloaded.stdout).strip())
        return False

    emit("upstreams_applied", replicas=[item["label"] for item in replicas])
    return True


def mem_available_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable absent de /proc/meminfo")


def wait_until_ready(replica: dict[str, Any]) -> bool:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    first_ready_at: float | None = None
    while time.monotonic() < deadline:
        if health(replica):
            if first_ready_at is None:
                first_ready_at = time.monotonic()
            if time.monotonic() - first_ready_at >= WARMUP_SECONDS:
                return True
        else:
            first_ready_at = None
        time.sleep(1)
    return False


def delete_replica(replica: dict[str, Any]) -> None:
    pm2("delete", replica["name"], check=False)


def start_replica(replica: dict[str, Any], current: list[dict[str, Any]]) -> bool:
    available_before = mem_available_mb()
    if available_before < MIN_AVAILABLE_BEFORE_MB:
        emit(
            "scale_out_blocked_memory",
            available_mb=available_before,
            required_mb=MIN_AVAILABLE_BEFORE_MB,
        )
        return False

    delete_replica(replica)
    process_env = {
        "PORT": str(replica["port"]),
        "HOST": "127.0.0.1",
        "NODE_ENV": "production",
        "NODE_ROLE": "web",
        "POLICIERCONGO_LOCAL_ENABLED": "false",
        "INSTANCE_ID": f"autoscale-{replica['label']}",
    }
    result = pm2(
        "start",
        str(APP_DIR / SERVER_SCRIPT),
        "--name",
        replica["name"],
        "--cwd",
        str(APP_DIR),
        "--time",
        "--kill-timeout",
        "10000",
        process_env=process_env,
        check=False,
    )
    if result.returncode != 0:
        emit("scale_out_start_failed", replica=replica["label"], error=(result.stderr or result.stdout).strip())
        delete_replica(replica)
        return False

    if not wait_until_ready(replica):
        emit("scale_out_health_failed", replica=replica["label"])
        delete_replica(replica)
        return False

    available_after = mem_available_mb()
    if available_after < MIN_AVAILABLE_AFTER_MB:
        emit(
            "scale_out_rolled_back_memory",
            replica=replica["label"],
            available_mb=available_after,
            required_mb=MIN_AVAILABLE_AFTER_MB,
        )
        delete_replica(replica)
        return False

    if not apply_upstreams([*current, replica]):
        delete_replica(replica)
        return False

    emit(
        "scaled_out",
        replica=replica["label"],
        port=replica["port"],
        available_mb=available_after,
    )
    return True


def stop_replica(replica: dict[str, Any], remaining: list[dict[str, Any]]) -> bool:
    if not apply_upstreams(remaining):
        return False
    if DRAIN_SECONDS > 0:
        time.sleep(DRAIN_SECONDS)
    delete_replica(replica)
    emit("scaled_in", replica=replica["label"], port=replica["port"])
    return True


def restart_replica(replica: dict[str, Any], active: list[dict[str, Any]]) -> bool:
    """Retire une réplique du trafic, la redémarre puis la réinsère saine."""
    remaining = [item for item in active if item != replica]
    if not apply_upstreams(remaining):
        return False
    if DRAIN_SECONDS > 0:
        time.sleep(DRAIN_SECONDS)
    delete_replica(replica)
    changed = start_replica(replica, remaining)
    if changed:
        emit("restarted", replica=replica["label"], port=replica["port"])
    return changed


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def split_upstream_field(value: Any) -> list[str]:
    return [part.strip() for part in str(value or "").split(",")]


def recent_attempts() -> list[dict[str, Any]]:
    if not METRICS_LOG.exists():
        return []
    size = METRICS_LOG.stat().st_size
    with METRICS_LOG.open("rb") as handle:
        if size > MAX_LOG_BYTES:
            handle.seek(size - MAX_LOG_BYTES)
            handle.readline()
        raw = handle.read()

    cutoff = time.time() - WINDOW_SECONDS
    attempts: list[dict[str, Any]] = []
    for raw_line in raw.splitlines():
        try:
            row = json.loads(raw_line)
            if float(row.get("ts", 0)) < cutoff:
                continue
            addresses = split_upstream_field(row.get("addr"))
            statuses = split_upstream_field(row.get("status"))
            response_times = split_upstream_field(row.get("rt"))
            for address, status, response_time in itertools.zip_longest(
                addresses, statuses, response_times, fillvalue="-"
            ):
                if address not in LOCAL_ADDRS and address != BASE_B_ADDR:
                    continue
                try:
                    status_code = int(status)
                except (TypeError, ValueError):
                    status_code = 0
                try:
                    latency = float(response_time)
                except (TypeError, ValueError):
                    latency = None
                attempts.append(
                    {
                        "side": "a" if address in LOCAL_ADDRS else "b",
                        "address": address,
                        "status": status_code,
                        "latency": latency,
                    }
                )
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return attempts


def stats(attempts: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [item["latency"] for item in attempts if item["latency"] is not None]
    errors = sum(1 for item in attempts if item["status"] == 0 or item["status"] >= 500)
    count = len(attempts)
    return {
        "requests": count,
        "rps": round(count / WINDOW_SECONDS, 2),
        "p95_seconds": round(percentile(latencies, 0.95), 4),
        "error_rate": round(errors / count, 4) if count else 0.0,
    }


def overloaded(summary: dict[str, Any], minimum: int) -> bool:
    return summary["requests"] >= minimum and (
        summary["p95_seconds"] >= HIGH_P95_SECONDS
        or summary["error_rate"] >= HIGH_ERROR_RATE
    )


def load_state() -> dict[str, Any]:
    defaults = {"high_streak": 0, "low_streak": 0, "last_action": 0.0}
    try:
        loaded = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        defaults.update(loaded)
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        pass
    return defaults


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(STATE_FILE, json.dumps(state, sort_keys=True) + "\n")


def snapshot(active: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = recent_attempts()
    a_stats = stats([item for item in attempts if item["side"] == "a"])
    b_stats = stats([item for item in attempts if item["side"] == "b"])
    all_stats = stats(attempts)
    backend_addresses = {
        "A": BASE_A_ADDR,
        "B": BASE_B_ADDR,
        **{item["label"].upper(): f"127.0.0.1:{item['port']}" for item in REPLICAS},
    }
    backends = {
        label: stats([item for item in attempts if item["address"] == address])
        for label, address in backend_addresses.items()
    }
    return {
        "active_replicas": [item["label"] for item in active],
        "memory_available_mb": mem_available_mb(),
        "a": a_stats,
        "b": b_stats,
        "all": all_stats,
        "backends": backends,
    }


def autoscale(action: str, replica_label: str | None = None) -> int:
    processes = pm2_processes()
    active = healthy_replicas(processes)
    if not apply_upstreams(active):
        return 1

    report = snapshot(active)
    if action == "status":
        emit("status", **report)
        return 0

    state = load_state()
    now = time.time()

    if action in {"start", "restart", "delete"}:
        target = REPLICA_BY_LABEL.get(str(replica_label or "").lower())
        if target is None:
            emit("replica_action_rejected", action=action, replica=replica_label)
            return 1
        if action == "start":
            if target in active:
                emit("start_skipped", reason="réplique déjà active", replica=target["label"])
                return 0
            changed = start_replica(target, active)
        elif action == "restart":
            if target not in active:
                emit("restart_skipped", reason="réplique inactive", replica=target["label"])
                return 1
            changed = restart_replica(target, active)
        else:
            if target not in active:
                emit("delete_skipped", reason="réplique inactive", replica=target["label"])
                return 0
            changed = stop_replica(target, [item for item in active if item != target])
        if changed:
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
            save_state(state)
        return 0 if changed else 1

    if action == "force-up":
        target = next((item for item in REPLICAS[:MAX_REPLICAS] if item not in active), None)
        if target is None:
            emit("force_up_skipped", reason="maximum déjà actif", **report)
            return 0
        changed = start_replica(target, active)
        if changed:
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
            save_state(state)
        return 0 if changed else 1

    if action == "force-down":
        if not active:
            emit("force_down_skipped", reason="aucune réplique active", **report)
            return 0
        target = max(active, key=lambda item: item["port"])
        remaining = [item for item in active if item != target]
        changed = stop_replica(target, remaining)
        if changed:
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
            save_state(state)
        return 0 if changed else 1

    a_high = overloaded(report["a"], MIN_REQUESTS_PER_SIDE)
    b_high = overloaded(report["b"], MIN_REQUESTS_PER_SIDE)
    overall_high = overloaded(report["all"], MIN_REQUESTS_PER_SIDE * 2)
    wants_scale_out = (a_high and b_high) if not active else overall_high

    if wants_scale_out:
        state["high_streak"] = int(state.get("high_streak", 0)) + 1
    else:
        state["high_streak"] = 0

    enough_traffic = report["all"]["requests"] >= MIN_REQUESTS_PER_SIDE * 2
    is_low = not enough_traffic or (
        report["all"]["p95_seconds"] <= LOW_P95_SECONDS
        and report["all"]["error_rate"] <= LOW_ERROR_RATE
    )
    state["low_streak"] = int(state.get("low_streak", 0)) + 1 if is_low else 0

    since_action = now - float(state.get("last_action", 0))
    changed = False
    if (
        state["high_streak"] >= HIGH_STREAK_REQUIRED
        and len(active) < MAX_REPLICAS
        and since_action >= SCALE_OUT_COOLDOWN
    ):
        target = next(item for item in REPLICAS[:MAX_REPLICAS] if item not in active)
        changed = start_replica(target, active)
    elif (
        active
        and state["low_streak"] >= LOW_STREAK_REQUIRED
        and since_action >= SCALE_IN_COOLDOWN
    ):
        target = max(active, key=lambda item: item["port"])
        changed = stop_replica(target, [item for item in active if item != target])

    if changed:
        state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
    save_state(state)
    emit(
        "evaluated",
        a_overloaded=a_high,
        b_overloaded=b_high,
        overall_overloaded=overall_high,
        high_streak=state["high_streak"],
        low_streak=state["low_streak"],
        changed=changed,
        **report,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--status", action="store_true")
    group.add_argument("--force-up", action="store_true")
    group.add_argument("--force-down", action="store_true")
    group.add_argument("--start", choices=sorted(REPLICA_BY_LABEL))
    group.add_argument("--restart", choices=sorted(REPLICA_BY_LABEL))
    group.add_argument("--delete", choices=sorted(REPLICA_BY_LABEL))
    args = parser.parse_args()
    if args.status:
        action, replica_label = "status", None
    elif args.force_up:
        action, replica_label = "force-up", None
    elif args.force_down:
        action, replica_label = "force-down", None
    elif args.start:
        action, replica_label = "start", args.start
    elif args.restart:
        action, replica_label = "restart", args.restart
    elif args.delete:
        action, replica_label = "delete", args.delete
    else:
        action, replica_label = "once", None

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("w", encoding="ascii") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit("skipped", reason="une évaluation est déjà en cours")
            return 0
        try:
            return autoscale(action, replica_label)
        except Exception as error:
            emit("fatal", error=str(error))
            return 1


if __name__ == "__main__":
    sys.exit(main())
