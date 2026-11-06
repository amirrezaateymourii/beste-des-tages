// Shrinks a photo before upload: max 1600 px on the long side, JPEG.
// Re-drawing it through a canvas also strips the EXIF data, including the
// GPS location many phones put in photos.


export async function preparePhoto(file, MAX = 1600) {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't a photo");

  let img;
  try {
    img = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that photo"));
      el.src = URL.createObjectURL(file);
    });
  }

  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
  return { blob, url: URL.createObjectURL(blob) };
}
