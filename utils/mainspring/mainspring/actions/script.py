"""
Script runner action.
"""

import asyncio
import os
import signal
import time
from typing import Any, Dict, List, Optional, Union

from ..core import Action, EventBus


class ScriptAction(Action):
    """
    Runs a local command and succeeds when it exits with status 0.

    Config:
      command:  a string (run through the shell) or a list (executed directly)
      cwd:      working directory (default: mainspring's)
      env:      extra environment variables
      timeout:  seconds before the process group is killed (default 3600, 0 = none)
      lock:     name of a lock shared by all script actions using the same name
                (default "default"), so overlapping triggers run one at a time

    The trigger context is exposed as MAINSPRING_SOURCE and MAINSPRING_DESCRIPTION.
    Output is streamed to the log line by line.
    """

    _locks: Dict[str, asyncio.Lock] = {}

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        super().__init__(name, config, event_bus)
        self.command: Union[str, List[str], None] = config.get("command")
        self.cwd: Optional[str] = config.get("cwd")
        self.env: Dict[str, str] = {k: str(v) for k, v in (config.get("env") or {}).items()}
        self.timeout: float = float(config.get("timeout", 3600))
        self.lock_name: str = config.get("lock", "default")

        if isinstance(self.command, list):
            self.command = [str(part) for part in self.command]
        if not self.command:
            raise ValueError(f"ScriptAction {name} requires 'command' in config")

    def _lock(self) -> asyncio.Lock:
        return self._locks.setdefault(self.lock_name, asyncio.Lock())

    @staticmethod
    def _kill(proc: asyncio.subprocess.Process):
        """Kill the process and, where supported, everything it spawned"""
        if proc.returncode is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except ProcessLookupError:
            pass

    async def _stream_output(self, proc: asyncio.subprocess.Process):
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            self._logger.info(line.decode(errors="replace").rstrip())

    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        env = {
            **os.environ,
            "MAINSPRING_SOURCE": str(context.get("source", "")),
            "MAINSPRING_DESCRIPTION": str(context.get("description", "")),
            **self.env,
        }
        spawn_kwargs: Dict[str, Any] = dict(
            cwd=self.cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=2 ** 24,
        )
        if os.name == "posix":
            spawn_kwargs["start_new_session"] = True  # own process group, so a timeout kills children too

        async with self._lock():
            self._logger.info(f"Running: {self.command}")
            started = time.monotonic()

            if isinstance(self.command, list):
                proc = await asyncio.create_subprocess_exec(*self.command, **spawn_kwargs)
            else:
                proc = await asyncio.create_subprocess_shell(self.command, **spawn_kwargs)

            try:
                await asyncio.wait_for(
                    asyncio.gather(self._stream_output(proc), proc.wait()),
                    timeout=self.timeout or None,
                )
            except asyncio.TimeoutError:
                self._kill(proc)
                await proc.wait()
                self._logger.error(f"Script timed out after {self.timeout:g}s")
                return False, {"command": self.command, "timed_out": True}
            except BaseException:
                # includes cancellation on shutdown
                self._kill(proc)
                raise

            duration = round(time.monotonic() - started, 1)
            action_data = {"command": self.command, "returncode": proc.returncode, "duration": duration}
            if proc.returncode != 0:
                self._logger.error(f"Script exited with status {proc.returncode} after {duration}s")
                return False, action_data

            self._logger.info(f"Script finished in {duration}s")
            return True, action_data
