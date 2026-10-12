# Ravjagt

Privat web-app til telefonen: hvor og hvornår der er rav på stranden mellem Hvide Sande og Sidselbjerg – og en logbog, der gør modellen klogere for hver tur.

## Hvad den gør

- **Kort med farvet kyst** (grøn/gul/rød) i strækninger på ca. 1 km, plus moler og bølgebrydere som "fælder".
- **Tidslinje** for de næste 5 døgn. Tryk på en time for at se kortet på det tidspunkt. Mørke timer er markeret (UV-lygten virker kun i mørke).
- **Start tur her** sætter en nål, hvor du starter. En pil og en afstand viser vej tilbage, også når alt ligner hinanden i mørke. Skærmen holdes tændt.
- **+ Fund her** sætter et fund på kortet. Ved afslutning: antal, UV ja/nej, note.
- **Rammer modellen?** viser fund pr. time fordelt på grøn/gul/rød, så vi kan se, om farverne passer.
- Virker offline med det seneste vejr. Din position forlader aldrig telefonen.

## Modellen (v0.2 – en hypotese)

Scoren svarer på: **skal jeg gå ud nu med UV-lygten?** Grøn kræver, at vinden har lagt sig, og at det er mørkt. Dagslys kan højst blive gul.

Se `js/model.js`.

| Faktor | Hvorfor |
|---|---|
| Pålandsvind i snit over 12 timer, de sidste 3 døgn (aftager efter 12 t) | Rav driver ind med tang efter vedvarende vestenvind |
| Bølgehøjde | Mere energi = mere materiale op fra bunden |
| Stormen står stadig på → lavere | Rav ruller i brændingen, og det er farligt at gå |
| Dagslys → højst gul | UV-lygten virker kun i mørke |
| Fralandsvind nu → lavere | Intet nyt kommer ind |
| Lavvande → højere | Mere strand fri |
| Strøm langs kysten + side af mole | Materialet samles på den side, strømmen løber imod |

Grøn ≥ 55, gul ≥ 30. Vægtene er sat efter erfaringsregler, ikke målt. De skal kalibreres med egne ture – også dem uden fund.

## Data

- Vejr og hav: [Open-Meteo](https://open-meteo.com) (forecast og marine), to punkter. Historisk vejr kan hentes fra Open-Meteos arkiv, så vi behøver ikke selv logge vejret – kun turene.
- Kyst, moler og bølgebrydere: © OpenStreetMap-bidragydere (Overpass, hentet 12.10.2026) → `data/coast.json`.
- Kort: Esri Dark Gray Canvas og World Imagery.

## Kør lokalt

```bash
python3 -m http.server 8765
```

Åbn `http://127.0.0.1:8765/?demo` for en simuleret gåtur ved Søndervig.

## Næste skridt

- Synk ture til en lille database, så de ikke kun ligger på telefonen.
- Kalibrér modellen på egne ture + Open-Meteo-arkivet.
- Udvid til flere kyster (fx Skallingen, Blåvandshuk, Thyborøn).
