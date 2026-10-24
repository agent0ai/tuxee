const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
const emblem = new Image();
let markerColor = '';
emblem.onload = () => setFaviconColor(markerColor);
emblem.src = '/favicon.png';

export function setFaviconColor(color = '') {
    markerColor = color;
    if (!color || !emblem.complete || !emblem.naturalWidth) {
        link.href = '/favicon.png';
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.drawImage(emblem, 0, 0, 64, 64);
    const tint = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
    const pixels = context.getImageData(0, 0, 64, 64);
    for (let i = 0; i < pixels.data.length; i += 4) {
        const [red, green, blue] = pixels.data.subarray(i, i + 3);
        if (red < green || green <= blue) continue;
        // Replace the yellow chroma, retaining neutral shading and edge alpha.
        const strength = (red - blue) / 255;
        for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = blue + tint[channel] * strength;
    }
    context.putImageData(pixels, 0, 0);
    link.href = canvas.toDataURL('image/png');
}
