import { Head, Html, Main, NextScript } from 'next/document';
import { Redline } from '@umage.ai/redline/next/script';

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
        <Redline />
      </body>
    </Html>
  );
}
