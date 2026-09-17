-- Senha provisória: marca que a pessoa PRECISA trocar a senha antes de usar
-- o sistema. Nasce ligada em duas situações: no admin do primeiro boot, cuja
-- senha aparece no log do servidor, e em toda redefinição feita por um
-- administrador — nos dois casos a senha passou pela mão de outra pessoa.
--
-- Sem isto, quem cria o usuário sabe a senha dele para sempre, e a trilha
-- imutável perde o sentido: não dá para afirmar quem registrou um evento se
-- duas pessoas podiam entrar com a mesma conta.

ALTER TABLE usuarios ADD COLUMN senha_provisoria INTEGER NOT NULL DEFAULT 0;
