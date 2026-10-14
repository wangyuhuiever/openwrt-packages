"""Regression tests for UCI links and the dangerous template save pipeline.

Run with python3 -m unittest discover -s luci-app-nginx-manager/tests -v.
All absolute router paths are redirected to a temporary directory. The real
shell functions run with nginx, nginx-util and rpcd JSON helpers stubbed.
"""

import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest


PACKAGE = Path(__file__).resolve().parents[1]
GENERATOR = PACKAGE / "root/usr/sbin/nginx-manager-gen"
RPCD = PACKAGE / "root/usr/libexec/rpcd/nginx_manager"
HEADER = "# This file is re-created when Nginx starts.\n"


def function(source, name):
    return re.search(r"^" + name + r"\(\) \{\n.*?^\}\n", source, re.M | re.S)[0]


class NginxUciTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nginx-uci-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.shell = shlex.split(os.environ.get("NGINX_TEST_SHELL", "/bin/sh"))
        self.conf = self.root / "etc/nginx/uci.conf"
        self.template = self.root / "etc/nginx/uci.conf.template"
        self.target = self.root / "var/lib/nginx/uci.conf"
        self.events = self.root / "events"
        for path in (self.conf, self.target, self.root / "bin/uci"):
            path.parent.mkdir(parents=True, exist_ok=True)
        self.template.write_text("worker_processes auto;\nsendfile on;\n")
        self.target.write_text(HEADER + self.template.read_text())
        self.conf.symlink_to(self.target)

        source = self.remap(GENERATOR.read_text())
        self.library = self.root / "generator-library.sh"
        self.library.write_text(source.split('\ncase "$1" in\n')[0])
        self.write_script("usr/sbin/nginx-manager-gen", source)
        self.write_script("bin/uci", """#!/bin/sh
case "$*" in
  '-q get nginx.global.uci_enable') echo "${UCI_ENABLED:-true}" ;;
  '-q get nginx_manager.global.dangerous_core_edit') echo 1 ;;
  '-q get nginx_manager.global.gzip')
    [ -n "$GENERATE_GLOBAL_GZIP" ] || exit 1; echo "$GENERATE_GLOBAL_GZIP" ;;
  *) exit 1 ;;
esac
""")
        self.write_script("usr/bin/nginx-util", """#!/bin/sh
echo render >> "$TEST_ROOT/events"
grep -q FAIL_GENERATE "$TEST_ROOT/etc/nginx/uci.conf.template" && exit 1
printf '%s\n' '# This file is re-created when Nginx starts.' > "$TEST_ROOT/var/lib/nginx/uci.conf"
cat "$TEST_ROOT/etc/nginx/uci.conf.template" >> "$TEST_ROOT/var/lib/nginx/uci.conf"
""")
        self.write_script("bin/nginx", """#!/bin/sh
echo test >> "$TEST_ROOT/events"
if grep -q INVALID "$3"; then echo 'invalid directive' >&2; exit 1; fi
""")
        self.write_script("etc/init.d/nginx", """#!/bin/sh
echo reload >> "$TEST_ROOT/events"
if [ -f "$TEST_ROOT/fail-reload-once" ]; then
  rm "$TEST_ROOT/fail-reload-once"; echo 'reload failed' >&2; exit 1
fi
[ ! -f "$TEST_ROOT/fail-reload-always" ]
""")
        self.rpc_functions = "\n".join(
            function(self.remap(RPCD.read_text()), name)
            for name in ("load_global_config", "detect_nginx_conf", "handle_set_file_dangerous")
        )

    def remap(self, source):
        return re.sub(r"/(etc|var|usr|lib|tmp)/", lambda m: str(self.root) + m[0], source)

    def write_script(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o755)

    def run_shell(self, code, **extra):
        env = dict(os.environ, TEST_ROOT=str(self.root),
                   PATH=str(self.root / "bin") + ":" + os.environ["PATH"], **extra)
        result = subprocess.run(self.shell + ["-c", code], env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def run_generator(self, code, **extra):
        return self.run_shell('. ' + shlex.quote(str(self.library)) + '\n' + code, **extra)

    def save_template(self, content):
        helpers = """
json_get_var() {
  case "$2" in
    path) file_path="$INPUT_PATH" ;;
    content) content="$INPUT_CONTENT" ;;
  esac
}
json_init() { :; }
json_add_string() { printf '%s=%s\n' "$1" "$2"; }
json_dump() { :; }
"""
        return self.run_shell(self.rpc_functions + helpers + "handle_set_file_dangerous\n",
                              INPUT_PATH=str(self.template), INPUT_CONTENT=content,
                              NGINX_MANAGER_GEN=str(self.root / "usr/sbin/nginx-manager-gen"),
                              NGINX_MANAGER_CONFIG=str(self.root / "etc/config/nginx_manager"))

    def event_list(self):
        return self.events.read_text().splitlines() if self.events.exists() else []

    def test_strip_and_restore_keep_symlink_and_permissions(self):
        self.target.chmod(0o640)
        self.run_generator('_strip_directives_from_file ' + shlex.quote(str(self.conf)))
        # ssl_prefer_server_ciphers is always managed, even with no UCI overrides.
        self.target.write_text("ssl_prefer_server_ciphers on;\n")
        self.run_generator('_strip_directives_from_file ' + shlex.quote(str(self.conf)))
        self.assertTrue(self.conf.is_symlink())
        self.assertIn("#managed-by-nginx-manager", self.target.read_text())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o640)
        self.run_generator('_restore_directives_in_file ' + shlex.quote(str(self.conf)))
        self.assertTrue(self.conf.is_symlink())
        self.assertEqual(self.target.read_text(), "ssl_prefer_server_ciphers on;\n")
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o640)
        self.assertFalse(list(self.target.parent.glob("uci.conf.*")))

    def test_changed_template_is_rendered_before_test(self):
        self.template.write_text("worker_processes 1;\n")
        self.run_generator("test_nginx_config")
        self.assertIn("worker_processes 1;", self.conf.read_text())
        self.assertEqual(self.event_list(), ["render", "test"])

    def test_legacy_generated_file_is_backed_up_and_link_repaired(self):
        old = HEADER + "worker_processes auto;\n"
        self.conf.unlink()
        self.conf.write_text(old)
        self.template.write_text("worker_processes 1;\n")
        self.run_generator("prepare_uci_config")
        self.assertTrue(self.conf.is_symlink())
        self.assertEqual(Path(str(self.conf) + ".before-link-repair").read_text(), old)
        self.assertIn("worker_processes 1;", self.conf.read_text())
        self.run_generator("prepare_uci_config")
        self.assertEqual(Path(str(self.conf) + ".before-link-repair").read_text(), old)

    def test_reload_without_validation_repairs_legacy_link(self):
        self.conf.unlink()
        self.conf.write_text(HEADER + "worker_processes auto;\n")
        self.template.write_text("worker_processes 1;\n")
        self.run_generator("reload_nginx")
        self.assertTrue(self.conf.is_symlink())
        self.assertIn("worker_processes 1;", self.conf.read_text())
        self.assertEqual(self.event_list(), ["render", "reload"])

    def test_manager_default_cache_has_its_own_zone(self):
        self.run_generator('mkdir -p "$BUILD_DIR"\ngenerate_global_conf',
                           GENERATE_GLOBAL_GZIP="0")
        generated = (self.root / "tmp/nginx-manager-build/00-global.conf").read_text()
        self.assertIn("ssl_session_cache shared:SSL_MANAGER:10m;", generated)
        self.assertNotIn("ssl_session_cache shared:SSL:10m;", generated)

    def test_installation_migrates_only_the_old_default_cache(self):
        defaults = (PACKAGE / "root/etc/uci-defaults/90-luci-app-nginx-manager").read_text()
        migration = defaults.split("changed=0\n", 1)[1].split(
            "uci -q get nginx_manager.global.max_backups", 1)[0]
        makefile = (PACKAGE / "Makefile").read_text()
        postinst = makefile.split("\tchanged=0; \\\n", 1)[1].split(
            "\tuci -q get nginx_manager.global.max_backups", 1)[0]
        postinst = postinst.replace("$$$$", "$").replace("; \\\n", "\n").replace(" \\\n", "\n")
        for snippet in (migration, postinst):
            for old, expected in (("shared:SSL:10m", "shared:SSL_MANAGER:10m"),
                                  ("shared:Custom:12m", "shared:Custom:12m"), ("", "")):
                with self.subTest(old=old, snippet=snippet):
                    code = """
cache="$OLD_CACHE"
uci() {
  case "$1" in
    -q) printf '%s' "$cache" ;;
    set) cache="${2#*=}" ;;
  esac
}
changed=0
""" + snippet + "\nprintf 'cache=%s\\n' \"$cache\"\n"
                    self.assertEqual(self.run_shell(code, OLD_CACHE=old).strip(),
                                     "cache=" + expected)

    def test_custom_regular_config_is_preserved(self):
        self.conf.unlink()
        self.conf.write_text("# custom config\nworker_processes 2;\n")
        self.run_generator("prepare_uci_config")
        self.assertFalse(self.conf.is_symlink())
        self.assertIn("worker_processes 2;", self.conf.read_text())

    def test_generated_header_inside_custom_config_does_not_trigger_repair(self):
        self.conf.unlink()
        content = "# custom config\n" + HEADER + "worker_processes 2;\n"
        self.conf.write_text(content)
        self.run_generator("prepare_uci_config")
        self.assertFalse(self.conf.is_symlink())
        self.assertEqual(self.conf.read_text(), content)

    def test_disabled_uci_does_not_generate_or_repair(self):
        self.conf.unlink()
        self.conf.write_text(HEADER + "worker_processes 2;\n")
        self.run_generator("prepare_uci_config", UCI_ENABLED="false")
        self.assertFalse(self.conf.is_symlink())
        self.assertEqual(self.event_list(), [])

    def test_valid_save_renders_tests_and_reloads(self):
        output = self.save_template("worker_processes 1;\n")
        self.assertIn("result=ok", output)
        self.assertTrue(self.conf.is_symlink())
        self.assertIn("worker_processes 1;", self.conf.read_text())
        self.assertEqual(self.event_list(), ["render", "test", "reload"])

    def test_save_repairs_legacy_link_and_applies_template(self):
        self.conf.unlink()
        self.conf.write_text(HEADER + "worker_processes auto;\n")
        output = self.save_template("worker_processes 1;\n")
        self.assertIn("result=ok", output)
        self.assertTrue(self.conf.is_symlink())
        self.assertIn("worker_processes 1;", self.conf.read_text())
        self.assertEqual(self.event_list(), ["render", "test", "reload"])

    def test_backup_failure_does_not_modify_configuration(self):
        old = self.template.read_text()
        backup_dir = self.root / "etc/nginx-manager/backups"
        backup_dir.parent.mkdir(parents=True)
        backup_dir.write_text("not a directory\n")
        output = self.save_template("worker_processes 1;\n")
        self.assertIn("error=failed to back up configuration", output)
        self.assertNotIn("result=ok", output)
        self.assertEqual(self.template.read_text(), old)
        self.assertEqual(self.event_list(), [])

    def test_invalid_template_restores_template_and_rendered_config(self):
        old = self.template.read_text()
        output = self.save_template("INVALID;\n")
        self.assertIn("error=", output)
        self.assertIn("rolled_back=1", output)
        self.assertNotIn("result=ok", output)
        self.assertEqual(self.template.read_text(), old)
        self.assertEqual(self.conf.read_text(), HEADER + old)
        self.assertEqual(self.event_list(), ["render", "test", "render", "test", "reload"])

    def test_generation_failure_restores_template_without_testing_stale_config(self):
        old = self.template.read_text()
        output = self.save_template("FAIL_GENERATE;\n")
        self.assertIn("error=", output)
        self.assertIn("rolled_back=1", output)
        self.assertEqual(self.template.read_text(), old)
        self.assertEqual(self.event_list(), ["render", "render", "test", "reload"])

    def test_reload_failure_rolls_back_and_reports_error(self):
        old = self.template.read_text()
        (self.root / "fail-reload-once").touch()
        output = self.save_template("worker_processes 1;\n")
        self.assertIn("error=", output)
        self.assertIn("rolled_back=1", output)
        self.assertNotIn("result=ok", output)
        self.assertEqual(self.template.read_text(), old)
        self.assertEqual(self.conf.read_text(), HEADER + old)

    def test_failed_rollback_is_not_reported_as_success(self):
        (self.root / "fail-reload-always").touch()
        output = self.save_template("worker_processes 1;\n")
        self.assertIn("error=", output)
        self.assertIn("rolled_back=0", output)
        self.assertNotIn("result=ok", output)


if __name__ == "__main__":
    unittest.main()
