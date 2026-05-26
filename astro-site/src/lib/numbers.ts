// Mirrors templates/macros/numbers.html `comma_string` macro: insert thousands commas.
// For value 0 it yields "0".
export function commaString(value: number | string): string {
  const numberString = String(value);
  let result = "";
  let letterCount = 0;
  const reversed = Array.from(numberString).reverse();
  for (const letter of reversed) {
    result = result + letter;
    letterCount += 1;
    if (letterCount > 2 && letterCount % 3 === 0 && letterCount !== numberString.length) {
      result = result + ",";
    }
  }
  return Array.from(result).reverse().join("");
}
