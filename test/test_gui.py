#!/usr/bin/env python3

# Allow direct execution
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import http.client
import json
import tempfile
import threading

from yt_dlp_gui.jobs import Job, friendly_error
from yt_dlp_gui.server import make_server
from yt_dlp_gui.settings import Settings


class TestFriendlyErrors(unittest.TestCase):
    def test_known_errors(self):
        self.assertIn('not a bot', friendly_error(
            'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. This helps protect our community.'))
        self.assertEqual(friendly_error('ERROR: [youtube] abc: Private video. Sign in if you have access'),
                         'This video is private.')
        self.assertIn('unavailable', friendly_error('ERROR: [youtube] abc: Video unavailable'))

    def test_unknown_error_is_cleaned(self):
        self.assertEqual(friendly_error('\x1b[0;31mERROR:\x1b[0m something odd'), 'something odd')


class TestSettings(unittest.TestCase):
    def test_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'settings.json')
            settings = Settings(path)
            self.assertEqual(settings.update({'format': 'flac', 'quality': 'bad', 'outdir': tmp, 'unknown': 1}), ['quality'])
            self.assertEqual(Settings(path).values['format'], 'flac')
            self.assertEqual(Settings(path).values['outdir'], tmp)
            self.assertEqual(Settings(path).values['quality'], '0')


class TestJobOptions(unittest.TestCase):
    def _opts(self, **kwargs):
        options = {'format': 'mp3', 'quality': '192K', 'outdir': '.', 'metadata': True,
                   'thumbnail': True, 'playlist': False, 'browser': '', **kwargs}
        return Job('https://www.youtube.com/watch?v=jNQXAC9IVRw', options)._ydl_opts()

    def test_audio_options(self):
        opts = self._opts()
        pps = {pp['key']: pp for pp in opts['postprocessors']}
        self.assertEqual(pps['FFmpegExtractAudio']['preferredcodec'], 'mp3')
        self.assertEqual(pps['FFmpegExtractAudio']['preferredquality'], '192')
        self.assertIn('EmbedThumbnail', pps)
        self.assertIn('FFmpegMetadata', pps)
        self.assertTrue(opts['noplaylist'])
        self.assertIsNone(opts.get('cookiesfrombrowser'))

    def test_wav_has_no_cover_art(self):
        keys = [pp['key'] for pp in self._opts(format='wav')['postprocessors']]
        self.assertNotIn('EmbedThumbnail', keys)

    def test_browser_login(self):
        self.assertEqual(self._opts(browser='firefox')['cookiesfrombrowser'][0], 'firefox')


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd, cls.app = make_server(0, os.path.join(cls.tmp.name, 'settings.json'))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def _request(self, method, path, body=None, token=True, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {'Host': host or f'127.0.0.1:{self.port}'}
        if token:
            headers['X-Token'] = self.app.token
        conn.request(method, path, body=json.dumps(body) if body else None, headers=headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data

    def test_index_has_token(self):
        status, data = self._request('GET', '/', token=False)
        self.assertEqual(status, 200)
        self.assertIn(self.app.token.encode(), data)

    def test_api_needs_token(self):
        self.assertEqual(self._request('GET', '/api/state', token=False)[0], 403)
        self.assertEqual(self._request('GET', '/api/state')[0], 200)

    def test_rejects_foreign_host(self):
        self.assertEqual(self._request('GET', '/', token=False, host='evil.example')[0], 403)

    def test_rejects_non_links(self):
        status, data = self._request('POST', '/api/jobs', {'url': 'hello'})
        self.assertEqual(status, 400)
        self.assertIn('link', json.loads(data)['error'])

    def test_reveal_only_known_paths(self):
        self.assertEqual(self._request('POST', '/api/reveal', {'path': '/etc'})[0], 403)

    def test_browse(self):
        status, data = self._request('GET', f'/api/browse?path={self.tmp.name}')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['path'], os.path.abspath(self.tmp.name))


if __name__ == '__main__':
    unittest.main()
