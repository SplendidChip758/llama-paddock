/**
 * The llama-paddock wordmark, built from parts so the name uses the page's font and the colours
 * follow the theme: a pixel llama, a prompt, the name and a cursor (brand/README.md).
 * The pixel art is drawn at 2x; other scales blur it.
 */
export function Logo() {
  return (
    <span className="logo">
      <svg className="logo-llama" viewBox="0 0 12 13" width="24" height="26" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M7 0h1v2h-1zM9 0h1v2h-1zM7 2h5v2h-5zM9 3h1v1h-1zM8 4h3v1h-3zM8 5h2v3h-2zM1 8h9v1h-9zM0 9h10v1h-10zM1 10h9v1h-9zM1 11h1v2h-1zM3 11h1v2h-1zM7 11h1v2h-1zM9 11h1v2h-1z"
        />
      </svg>
      <svg className="logo-prompt" viewBox="0 0 5 7" width="10" height="14" aria-hidden="true">
        <path d="M0 0h2v1h-2zM1 1h2v1h-2zM2 2h2v1h-2zM3 3h2v1h-2zM2 4h2v1h-2zM1 5h2v1h-2zM0 6h2v1h-2z" />
      </svg>
      <span className="logo-name">
        llama-paddock<span className="logo-cursor">_</span>
      </span>
    </span>
  );
}
