// Built-in words. They are used when no AI key is configured, when the AI is unavailable,
// and for the daily word. Each line is:  word|difficulty (1 easy .. 3 hard)|clue
// The "general" theme is the default pool and has words of every length from 4 to 8.

const parse = (language, theme, text) =>
  text.trim().split('\n').map((line) => {
    const [word, difficulty, clue] = line.split('|');
    return { language, theme, word: word.trim(), difficulty: Number(difficulty), clue: clue.trim() };
  });

const EN_GENERAL = `
moon|1|Earth's natural satellite
rain|1|Water falling from clouds
fire|1|Hot, bright and dangerous to touch
book|1|You read it page by page
tree|1|Tall plant with a trunk and leaves
door|1|You open it to enter a room
wolf|1|Wild relative of the dog that howls
snow|1|Frozen flakes that fall in winter
ship|1|A large boat that crosses the sea
lamp|1|It lights a room at night
gold|1|Shiny yellow metal, the prize for first place
star|1|A distant sun in the night sky
apple|1|Red or green fruit; one a day keeps the doctor away
river|1|Water that flows toward the sea
chair|1|You sit on it at a desk
bread|1|Baked from dough, sliced for toast
cloud|1|White shape drifting in the sky
dance|1|Move your body to music
flame|1|The glowing part of a fire
ghost|1|A spooky spirit in stories
heart|1|The organ that pumps blood
light|1|What a lamp gives off
money|1|Coins and bills
night|1|The dark part of the day
ocean|1|A huge body of salt water
piano|1|Keyboard instrument with 88 keys
queen|1|A female ruler
smile|1|A happy curve on the face
tiger|1|Big striped cat
water|1|Clear liquid you drink
world|1|The whole Earth and all its people
brain|1|The organ you think with
crown|2|Worn on a king's head
dream|1|What you see while asleep
earth|1|Our home planet
fruit|1|Sweet food that grows on trees
grass|1|Green cover of a lawn
house|1|A building where a family lives
juice|1|Squeezed from oranges
knife|1|A blade for cutting food
lemon|1|Sour yellow citrus
magic|1|A wizard's power
novel|2|A long fictional book
pearl|2|A gem made inside an oyster
quiet|2|Making almost no noise
robot|1|A machine that follows programs
storm|1|Thunder, lightning and heavy rain
train|1|It runs on rails
uncle|1|Your parent's brother
voice|1|The sound you speak with
wheel|1|A round part that rolls
ember|2|A glowing piece of burnt wood
fjord|3|A narrow sea inlet between steep cliffs
gauge|3|A tool for measuring
quirk|3|An odd little habit of a person
planet|1|A world that orbits a star
garden|1|Where flowers and vegetables grow
orange|1|A citrus fruit and a color
bridge|1|It carries a road over a river
castle|1|A fortress where a king might live
doctor|1|Treats sick people
forest|1|A large area full of trees
guitar|1|Stringed instrument you strum
island|1|Land surrounded by water
jungle|2|Dense tropical forest
market|1|A place to buy fresh food
pencil|1|Writes in grey and can be erased
balloon|1|Rubber bag filled with air or helium
blanket|1|Keeps you warm in bed
chicken|1|A farm bird that lays eggs
diamond|2|The hardest natural gem
dolphin|1|Clever sea mammal that clicks and whistles
giraffe|1|The tallest animal on land
kitchen|1|The room where meals are cooked
library|1|A place full of books to borrow
machine|1|A device that does work
mystery|2|Something unexplained or secret
penguin|1|Flightless bird of the cold south
rainbow|1|Colorful arc after rain
village|1|A small community in the countryside
weather|1|Sunny, rainy or windy conditions
whisper|2|Speak very softly
elephant|1|The largest land animal, with a trunk
mountain|1|Very high natural peak
umbrella|1|Keeps you dry in the rain
sandwich|1|Filling between two slices of bread
notebook|1|Paper pad for writing notes
treasure|1|Hidden pirate gold
universe|2|Everything that exists in space
airplane|1|A winged aircraft that flies
dinosaur|1|Giant reptile from millions of years ago
football|1|Played with an oval ball and touchdowns
hospital|1|Where doctors treat patients
painting|1|Artwork made with a brush
scissors|1|Two blades for cutting paper
vacation|1|Time off work to travel
birthday|1|The yearly day of your birth
`;

const EN_ANIMALS = `
wolf|1|Howling wild canine
bear|1|Large furry animal that hibernates
frog|1|Green amphibian that hops
eagle|1|Bird of prey with sharp eyes
zebra|1|Striped horse-like animal
horse|1|You can ride it as it gallops
shark|1|Sea predator with a fin on its back
panda|1|Black-and-white bear that eats bamboo
otter|2|Playful river animal that floats on its back
camel|1|Desert animal with humps
koala|1|Australian tree-dweller that eats eucalyptus
monkey|1|Playful climber that loves bananas
rabbit|1|Long-eared hopper that eats carrots
turtle|1|Slow reptile with a shell
parrot|1|Colorful bird that can mimic speech
giraffe|1|Long-necked animal of the savanna
penguin|1|Black-and-white bird that swims but cannot fly
dolphin|1|Playful sea mammal
cheetah|2|The fastest runner on land
elephant|1|Huge gray animal with a trunk
`;

const EN_FOOD = `
cake|1|Sweet birthday dessert
rice|1|Small white grains served with curry
soup|1|Hot liquid meal eaten with a spoon
pizza|1|Round dish with cheese and tomato
pasta|1|Italian noodles
mango|1|Sweet tropical fruit with a big stone
salad|1|Cold dish of mixed vegetables
apple|1|Crunchy red or green fruit
lemon|1|Sour yellow fruit squeezed into a cold drink
bread|1|Sliced for toast
burger|1|Meat patty in a bun
noodle|1|Long thin strand of dough in soup
cheese|1|Made from milk, comes in slices and wheels
chicken|1|Roasted bird on the dinner table
pancake|1|Flat round breakfast treat flipped in a pan
sandwich|1|Fillings between bread slices
`;

const EN_SPACE = `
moon|1|Earth's natural satellite
star|1|A sun far away in the night sky
orbit|1|Path of a planet around a star
comet|1|Icy visitor with a glowing tail
venus|2|The hottest planet
earth|1|The planet we live on
solar|1|Powered by the sun
galaxy|1|Huge group of stars, like the Milky Way
planet|1|A world that circles a star
meteor|2|A shooting star streaking across the sky
rocket|1|Vehicle that launches into space
saturn|2|Planet with famous rings
mercury|2|The planet closest to the sun
eclipse|2|When the moon hides the sun
asteroid|2|Rocky body drifting in space
universe|1|Everything that exists
`;

const EN_SPORTS = `
goal|1|What a striker scores
ball|1|Round object players kick or throw
swim|1|Move through water as a sport
score|1|Points a team has
coach|1|Trains and leads a team
tennis|1|Racket sport played over a net
soccer|1|Game with two goals and eleven players a side
hockey|1|Game played with sticks and a puck on ice
boxing|1|Sport fought with gloves in a ring
referee|2|Official who enforces the rules
stadium|1|Big arena with seats for fans
cycling|1|Racing on two wheels
football|1|Played with an oval ball and touchdowns
baseball|1|Bat, glove and home runs
`;

const RU_GENERAL = `
луна|1|Естественный спутник Земли
небо|1|Голубое днём, тёмное ночью, над головой
море|1|Большая солёная вода
река|1|Течёт от истока к устью
окно|1|Через него смотрят на улицу
лето|1|Самое тёплое время года
зима|1|Время снега и мороза
хлеб|1|Его пекут из муки
свет|1|Его даёт лампа
шкаф|1|Мебель для одежды
мост|1|Он соединяет два берега
часы|1|Показывают время
книга|1|Её читают
птица|1|У неё есть перья и крылья
лодка|1|Маленькое судно, плывёт по воде
кошка|1|Мурлычет и ловит мышей
школа|1|Здесь учатся дети
огонь|1|Горит и греет
ветер|1|Движение воздуха
цветы|1|Растут на клумбе, их дарят на праздник
дождь|1|Капли падают с неба
стена|1|Её красят, на ней висит картина
дверь|1|Её открывают и закрывают
волна|1|Бежит по морю
зебра|1|Полосатая лошадь из Африки
слово|1|Состоит из букв
рыбка|1|Плавает в аквариуме
песок|1|Жёлтые мелкие зёрнышки на пляже
трава|1|Зелёный ковёр на лугу
гроза|1|Гром и молния
земля|1|Наша планета и почва под ногами
лампа|1|Светит в комнате вечером
сосна|1|Хвойное дерево
мороз|1|Очень холодная погода
ручка|1|Ею пишут
банан|1|Жёлтый фрукт, любимый обезьянами
арбуз|1|Большая полосатая ягода с красной мякотью
лимон|1|Кислый жёлтый цитрус
чашка|1|Из неё пьют чай
робот|1|Машина, выполняющая программу
букет|1|Цветы, собранные в подарок
яблоко|1|Красный или зелёный фрукт с семечками
машина|1|Ездит по дороге
звезда|1|Далёкое солнце в ночном небе
музыка|1|Её слушают в наушниках
собака|1|Друг человека, умеет лаять
корова|1|Даёт молоко
лошадь|1|На ней ездят верхом
огурец|1|Зелёный овощ для салата
дорога|1|По ней едут машины
планета|1|Мир, который вращается вокруг звезды
картина|1|Её рисуют красками и вешают на стену
подарок|1|Его дарят на день рождения
морковь|1|Оранжевый корнеплод, любимое лакомство зайцев
шоколад|1|Сладкая плитка из какао
конфета|1|Сладость в обёртке
бабушка|1|Мама твоей мамы
площадь|1|Большое открытое место в городе
учитель|1|Он объясняет урок в классе
самолет|1|Летает по небу с пассажирами
динозавр|1|Гигантская рептилия из далёкого прошлого
вертолет|1|Летает с вращающимся винтом сверху
крокодил|1|Зубастый хищник в тропических реках
апельсин|1|Круглый оранжевый цитрус
праздник|1|День, когда все веселятся
карандаш|1|Рисует серым и стирается ластиком
портфель|1|С ним ходят в школу
`;

const RU_ANIMALS = `
волк|1|Воет на луну
лиса|1|Рыжая хитрая плутовка
слон|1|Огромное животное с хоботом
заяц|1|Длинноухий, любит морковь и быстро бегает
тигр|1|Полосатая большая кошка
кошка|1|Мурлычет и ловит мышей
зебра|1|Полосатая лошадь из Африки
жираф|2|Самое высокое животное на Земле
собака|1|Друг человека, умеет лаять
корова|1|Даёт молоко
лошадь|1|На ней ездят верхом
медведь|1|Зимой спит в берлоге
обезьяна|1|Ловко лазает и любит бананы
крокодил|1|Зубастый хищник в тропических реках
`;

const RU_FOOD = `
хлеб|1|Его пекут из муки
каша|1|Варят из крупы на молоке
торт|1|Праздничный десерт со свечками
борщ|1|Красный суп со свёклой
пицца|1|Круглое блюдо с сыром и томатами
салат|1|Холодное блюдо из овощей
пирог|1|Выпечка с начинкой
банан|1|Жёлтый фрукт
арбуз|1|Большая полосатая ягода
лимон|1|Кислый жёлтый цитрус
яблоко|1|Красный или зелёный фрукт
огурец|1|Зелёный овощ для салата
морковь|1|Оранжевый корнеплод
шоколад|1|Сладкая плитка из какао
конфета|1|Сладость в обёртке
апельсин|1|Круглый оранжевый цитрус
`;

const RU_SPACE = `
луна|1|Естественный спутник Земли
марс|1|Красная планета
звезда|1|Далёкое солнце в ночном небе
ракета|1|Летит в космос
комета|2|Небесный гость с длинным хвостом
орбита|2|Путь планеты вокруг звезды
венера|2|Самая горячая планета
юпитер|2|Самая большая планета
сатурн|2|Планета с кольцами
солнце|1|Звезда в центре нашей системы
планета|1|Мир, который вращается вокруг звезды
спутник|2|Летает вокруг планеты
астероид|2|Каменная глыба в космосе
`;

export const BANK = [
  ...parse('en', 'general', EN_GENERAL),
  ...parse('en', 'animals', EN_ANIMALS),
  ...parse('en', 'food', EN_FOOD),
  ...parse('en', 'space', EN_SPACE),
  ...parse('en', 'sports', EN_SPORTS),
  ...parse('ru', 'general', RU_GENERAL),
  ...parse('ru', 'животные', RU_ANIMALS),
  ...parse('ru', 'еда', RU_FOOD),
  ...parse('ru', 'космос', RU_SPACE),
];

// Themes shown as suggestions in the UI.
export const BANK_THEMES = {
  en: ['animals', 'food', 'space', 'sports'],
  ru: ['животные', 'еда', 'космос'],
};
