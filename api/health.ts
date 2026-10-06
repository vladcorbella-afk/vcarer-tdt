export default function handler(_req: any, res: any) {
  res.status(200).json({ status: 'ok', runtime: 'vercel-serverless' });
}
