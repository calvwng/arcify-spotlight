import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('verify_package', Path(__file__).with_name('verify-package.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageVerification(unittest.TestCase):
    def test_exact_and_rejected_packages(self):
        cases = ('exact', 'missing', 'extra', 'changed', 'duplicate', 'traversal', 'manifest')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                build = root / 'dist'
                build.mkdir()
                (build / 'manifest.json').write_bytes(b'{"manifest_version":3}')
                (build / 'background.js').write_bytes(b'code')
                source = root / 'manifest.json'
                source.write_bytes(b'changed' if case == 'manifest' else (build / 'manifest.json').read_bytes())
                archive = root / 'package.zip'
                with zipfile.ZipFile(archive, 'w') as output:
                    output.writestr('manifest.json', (build / 'manifest.json').read_bytes())
                    if case != 'missing':
                        output.writestr('background.js', b'wrong' if case == 'changed' else b'code')
                    if case == 'extra':
                        output.writestr('extra.js', b'code')
                    if case == 'duplicate':
                        output.writestr('background.js', b'code')
                    if case == 'traversal':
                        output.writestr('../escape', b'code')
                if case == 'exact':
                    self.assertEqual(len(module.verify_package(archive, build, source)['files']), 2)
                else:
                    with self.assertRaises(ValueError):
                        module.verify_package(archive, build, source)


if __name__ == '__main__':
    unittest.main()
