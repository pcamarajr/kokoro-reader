// Guess the gender of a person from their first name, entirely offline.
// Common names in the supported languages, then a few conservative endings.
// Anything unisex or unknown answers null, and the caller uses the default.

(() => {
  const set = (s) => new Set(s.split(/\s+/));

  const FEMALE = set(`
    maria ana anna ann anne annie amanda amelia alice alicia adriana aline alessandra alexandra andreia angela
    angelica barbara beatriz bianca bruna camila camille carla carolina caroline catarina catherine cecilia
    claudia clara cristina christina daniela debora deborah denise diana eduarda elena elisa elizabeth emily
    emma erica fabiana fernanda flavia francisca gabriela gabriella giovanna giulia helena isabel isabella
    isabelle jessica jennifer joana julia juliana julie karen katia kate katherine laura lara larissa leticia
    lidia lilian livia lucia luciana luisa luiza luana marcela marcia mariana marina marta mary melissa
    michelle monica natalia natalie nicole olivia paula patricia paola priscila rafaela raquel rebeca rebecca
    renata rita roberta sabrina samantha sandra sara sarah silvia sofia sophie stephanie suzana susan tatiana
    tereza teresa thais valentina vanessa vera veronica victoria viviane yasmin zoe jane megan lauren hannah
    rachel linda nancy karla lisa kimberly heather margaret dorothy sharon donna carol ruth amy angela anita
    charlotte chloe eleanor grace lucy mia ella ava lily lea manon ines sophia marie francoise nathalie
    isabela leila lorena leonor lais gisele giselle mirella renee
  `);

  const MALE = set(`
    joao jose antonio carlos pedro paulo lucas luiz luis luca marcos marco marcelo rafael rodrigo ricardo
    roberto rogerio ronaldo thiago tiago bruno gabriel gustavo guilherme felipe fernando fabio fabricio
    eduardo daniel diego davi david douglas emerson enzo erik eric fabiano francisco frederico henrique hugo
    igor ivan jorge julio leonardo leandro lucio matheus mateus mateo mauricio miguel murilo nelson nicolas
    otavio patrick renato renan ruan samuel sergio vinicius vitor victor wagner wesley william michael john
    james robert richard joseph thomas charles christopher matthew mark donald steven paul andrew joshua
    kenneth kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas jonathan larry
    justin scott brandon benjamin frank gregory raymond alexander jack dennis jerry tyler aaron henry adam
    nathan peter zachary kyle walter harold jeremy ethan carl keith roger arthur lawrence sean christian
    albert joe austin willie billy bryan bruce ralph roy noah dylan eugene wayne alan juan pierre jean louis
    jacques francois philippe laurent stefano giuseppe giovanni alessandro andre pablo javier sergio
    alejandro manuel raul jesus mario luigi paolo matteo lorenzo simon oliver harry jake liam nikita mustafa
  `);

  // Endings that lean one way; used only after the lists miss.
  const ROMANCE = /^(pt|es|it)$/;
  const FEMALE_END = /(ette|elle|lyn|lynn|een)$/;

  const TITLES = /^(by|por|par|di|dr|dra|prof|profa|sr|sra|mr|mrs|ms|mx|miss)\.?$/;

  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function firstName(fullName) {
    const tokens = fullName.trim().split(/\s+/);
    while (tokens.length > 1 && TITLES.test(norm(tokens[0]))) tokens.shift();
    return norm(tokens[0] || "").replace(/[^a-z-]/g, "").split("-")[0];
  }

  // `lang` is the article's language code, which decides the ambiguous endings.
  function guess(fullName, lang) {
    const name = firstName(fullName || "");
    if (name.length < 2) return null;
    if (name === "andrea") return lang === "it" ? "male" : "female";   // the one common name that flips
    if (FEMALE.has(name)) return "female";
    if (MALE.has(name)) return "male";
    if (FEMALE_END.test(name)) return "female";
    if (name.endsWith("a")) return "female";
    if (name.endsWith("o") && ROMANCE.test(lang)) return "male";
    return null;
  }

  self.KRNames = { guess };
})();
