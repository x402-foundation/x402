export default function ProtectedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-4xl font-bold mb-4">Protected Content</h1>
        <p className="text-lg">
          Your payment was successful! Enjoy this banger song.
        </p>
        <iframe width="100%" height="300" scrolling="no" frameBorder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/2044190296&color=%23ff5500&auto_play=true&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true"></iframe>
        <div style={{ fontSize: '10px', color: '#cccccc', lineBreak: 'anywhere', wordBreak: 'normal', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: 'Interstate,Lucida Grande,Lucida Sans Unicode,Lucida Sans,Garuda,Verdana,Tahoma,sans-serif', fontWeight: '100' }}>
          <a href="https://soundcloud.com/dan-kim-675678711" title="danXkim" target="_blank" style={{ color: '#cccccc', textDecoration: 'none' }}>danXkim</a> · <a href="https://soundcloud.com/dan-kim-675678711/x402" title="x402 (DJ Reppel Remix)" target="_blank" style={{ color: '#cccccc', textDecoration: 'none' }}>x402 (DJ Reppel Remix)</a>
        </div>
      </div>
    </div>
  );
}
